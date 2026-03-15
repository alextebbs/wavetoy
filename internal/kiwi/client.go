package kiwi

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sammy/sdr-radio/internal/streamlog"
)

type Config struct {
	Host          string
	Port          int
	UseTLS        bool
	Name          string
	FrequencyKHz  float64
	Mode          string
	BandwidthLoHz int
	BandwidthHiHz int
	AGCOn         bool
	AGCGainDB     *float64
}

type LogFunc func(level streamlog.LogLevel, action, from, to, msg string)

type Client struct {
	conn  *websocket.Conn
	label string
	logFn LogFunc

	closeOnce sync.Once
	writeMu   sync.Mutex
	adpcmMu   sync.Mutex

	done       chan struct{}
	pcm        chan []byte
	sampleRate atomic.Int64

	adpcmIndex int
	adpcmPrev  int

	sndFramesIn        atomic.Int64
	sndBytesIn         atomic.Int64
	sndCompressedIn    atomic.Int64
	sndUncompressedIn  atomic.Int64
	sndQueueDropFrames atomic.Int64
	sndFirstLogged     atomic.Bool
}

type Stats struct {
	SNDFramesIn        int64 `json:"snd_frames_in"`
	SNDBytesIn         int64 `json:"snd_bytes_in"`
	SNDCompressedIn    int64 `json:"snd_compressed_in"`
	SNDUncompressedIn  int64 `json:"snd_uncompressed_in"`
	SNDQueueDropFrames int64 `json:"snd_queue_drop_frames"`
}

// ConnectTimestamp returns a timestamp suitable for pairing SND + W/F connections
// into a single KiwiSDR channel slot.
func ConnectTimestamp() int64 {
	return time.Now().Unix()
}

func Connect(ctx context.Context, cfg Config, timestamp int64, logFn LogFunc) (*Client, error) {
	scheme := "ws"
	if cfg.UseTLS {
		scheme = "wss"
	}

	if timestamp == 0 {
		timestamp = time.Now().Unix()
	}

	endpoint := url.URL{
		Scheme: scheme,
		Host:   fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Path:   fmt.Sprintf("/%d/SND", timestamp),
	}

	label := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	if logFn != nil {
		logFn(streamlog.LevelDebug, "dial", "wavetoy", "kiwi", fmt.Sprintf("endpoint=%s", endpoint.String()))
	}

	dialer := websocket.Dialer{HandshakeTimeout: 20 * time.Second}
	conn, _, err := dialer.DialContext(ctx, endpoint.String(), nil)
	if err != nil {
		if logFn != nil {
			logFn(streamlog.LevelDebug, "dial", "wavetoy", "kiwi", fmt.Sprintf("failed: %v", err))
		}
		return nil, err
	}

	client := &Client{
		conn:  conn,
		label: label,
		logFn: logFn,
		done:  make(chan struct{}),
		pcm:   make(chan []byte, 64),
	}
	client.sampleRate.Store(12000)

	if err := client.init(cfg); err != nil {
		client.Close()
		return nil, err
	}

	go client.readLoop()
	go client.keepAliveLoop()
	return client, nil
}

func (c *Client) Samples() <-chan []byte {
	return c.pcm
}

func (c *Client) Done() <-chan struct{} {
	return c.done
}

func (c *Client) SampleRate() int {
	return int(c.sampleRate.Load())
}

func (c *Client) Stats() Stats {
	return Stats{
		SNDFramesIn:        c.sndFramesIn.Load(),
		SNDBytesIn:         c.sndBytesIn.Load(),
		SNDCompressedIn:    c.sndCompressedIn.Load(),
		SNDUncompressedIn:  c.sndUncompressedIn.Load(),
		SNDQueueDropFrames: c.sndQueueDropFrames.Load(),
	}
}

func (c *Client) Close() error {
	var closeErr error
	c.closeOnce.Do(func() {
		close(c.done)
		closeErr = c.conn.Close()
		close(c.pcm)
	})
	return closeErr
}

func (c *Client) init(cfg Config) error {
	cmds := buildInitCommands(cfg)
	for _, cmd := range cmds {
		if err := c.send(cmd); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) Reconfigure(cfg Config) error {
	cmds := buildRetuneCommands(cfg)
	for _, cmd := range cmds {
		if err := c.send(cmd); err != nil {
			return err
		}
	}
	return nil
}

func buildInitCommands(cfg Config) []string {
	cmds := []string{
		"SET auth t=kiwi p=",
		fmt.Sprintf("SET ident_user=%s", sanitizeName(cfg.Name)),
		"SET little-endian",
		"SET compression=0",
	}
	cmds = append(cmds, buildTuningCommands(cfg)...)
	cmds = append(cmds, "SET run=1")
	return cmds
}

func buildRetuneCommands(cfg Config) []string {
	cmds := []string{
		fmt.Sprintf("SET ident_user=%s", sanitizeName(cfg.Name)),
		"SET little-endian",
		"SET compression=0",
	}
	cmds = append(cmds, buildTuningCommands(cfg)...)
	return cmds
}

var modePassbandDefaults = map[string][2]int{
	"am":   {-4900, 4900},
	"amn":  {-2500, 2500},
	"amw":  {-6000, 6000},
	"sam":  {-4900, 4900},
	"sal":  {-4900, 0},
	"sau":  {0, 4900},
	"sas":  {-4900, 4900},
	"qam":  {-4900, 4900},
	"drm":  {-5000, 5000},
	"lsb":  {-2700, -300},
	"lsn":  {-2400, -300},
	"usb":  {300, 2700},
	"usn":  {300, 2400},
	"cw":   {300, 700},
	"cwn":  {470, 530},
	"nbfm": {-6000, 6000},
	"nnfm": {-3000, 3000},
	"iq":   {-5000, 5000},
}

func buildTuningCommands(cfg Config) []string {
	passbandLo := cfg.BandwidthLoHz
	passbandHi := cfg.BandwidthHiHz
	if passbandLo == 0 && passbandHi == 0 {
		if defaults, ok := modePassbandDefaults[strings.ToLower(cfg.Mode)]; ok {
			passbandLo = defaults[0]
			passbandHi = defaults[1]
		} else {
			passbandLo = -4900
			passbandHi = 4900
		}
	}

	cmds := []string{
		fmt.Sprintf("SET mod=%s low_cut=%d high_cut=%d freq=%.3f", cfg.Mode, passbandLo, passbandHi, cfg.FrequencyKHz),
		"SET squelch=0 max=0",
		"SET nb algo=1",
		"SET nb type=0 param=0 pval=100",
		"SET nb type=0 param=1 pval=50",
		"SET nb type=0 en=1",
	}

	if strings.EqualFold(cfg.Mode, "nbfm") {
		cmds = append(cmds, "SET de_emp=1")
	} else {
		cmds = append(cmds, "SET de_emp=0")
	}

	if cfg.AGCOn {
		cmds = append(cmds, "SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50")
	} else if cfg.AGCGainDB != nil {
		cmds = append(cmds, fmt.Sprintf("SET agc=0 hang=0 thresh=-100 slope=6 decay=1000 manGain=%d", int(math.Round(*cfg.AGCGainDB))))
	} else {
		cmds = append(cmds, "SET agc=0 hang=0 thresh=-100 slope=6 decay=1000 manGain=50")
	}
	return cmds
}

func (c *Client) readLoop() {
	defer c.Close()

	for {
		msgType, payload, err := c.conn.ReadMessage()
		if err != nil {
			if c.logFn != nil {
				c.logFn(streamlog.LevelWarn, "kiwi.read.exit", "kiwi", "wavetoy",
					fmt.Sprintf("%s: %v", c.label, err))
			}
			return
		}

		if msgType != websocket.BinaryMessage || len(payload) < 3 {
			continue
		}

		tag := string(payload[:3])
		body := payload[3:]

		switch tag {
		case "MSG":
			c.processMSG(body)
		case "SND":
			if len(body) > 7 {
				flags := body[0]
				c.sndFramesIn.Add(1)
				c.sndBytesIn.Add(int64(len(body) - 7))
				if flags&SND_FLAG_COMPRESSED != 0 {
					c.sndCompressedIn.Add(1)
				} else {
					c.sndUncompressedIn.Add(1)
				}
				if c.sndFirstLogged.CompareAndSwap(false, true) {
					compressed := flags&SND_FLAG_COMPRESSED != 0
					if c.logFn != nil {
						c.logFn(streamlog.LevelDebug, "kiwi.snd.first", "kiwi", "wavetoy",
							fmt.Sprintf("bytes=%d compressed=%v flags=0x%02x", len(body)-7, compressed, flags))
					}
				}
			}
			pcm, ok := c.processSND(body)
			if !ok || len(pcm) == 0 {
				continue
			}
			select {
			case c.pcm <- pcm:
			default:
				c.sndQueueDropFrames.Add(1)
			}
		}
	}
}

func (c *Client) keepAliveLoop() {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			if err := c.send("SET keepalive"); err != nil {
				return
			}
		}
	}
}

func (c *Client) send(cmd string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if cmd != "SET keepalive" && c.logFn != nil {
		c.logFn(streamlog.LevelDebug, "kiwi.cmd", "wavetoy", "kiwi", cmd)
	}
	return c.conn.WriteMessage(websocket.TextMessage, []byte(cmd))
}

func (c *Client) processMSG(body []byte) {
	if len(body) == 0 {
		return
	}
	text := string(body[1:])
	if c.logFn != nil {
		display := text
		if len(display) > 200 {
			display = display[:200] + "..."
		}
		c.logFn(streamlog.LevelDebug, "kiwi.msg", "kiwi", "wavetoy", display)
	}
	for _, pair := range strings.Split(text, " ") {
		if pair == "" {
			continue
		}
		if !strings.Contains(pair, "=") {
			continue
		}
		name, value, _ := strings.Cut(pair, "=")
		switch name {
		case "audio_rate":
			inRate, err := strconv.Atoi(value)
			if err != nil || inRate <= 0 {
				continue
			}
			outRate := c.SampleRate()
			if c.logFn != nil {
				c.logFn(streamlog.LevelDebug, "kiwi.samplerate", "kiwi", "wavetoy",
					fmt.Sprintf("audio_rate=%d → SET AR OK in=%d out=%d", inRate, inRate, outRate))
			}
			if err := c.send(fmt.Sprintf("SET AR OK in=%d out=%d", inRate, outRate)); err != nil {
				return
			}
		case "sample_rate":
			rate, err := strconv.ParseFloat(value, 64)
			if err != nil || rate <= 0 {
				continue
			}
			c.sampleRate.Store(int64(math.Round(rate)))
		case "audio_adpcm_state":
			parts := strings.Split(value, ",")
			if len(parts) != 2 {
				continue
			}
			index, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
			prev, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
			if err1 != nil || err2 != nil {
				continue
			}
			c.adpcmMu.Lock()
			c.adpcmIndex = clamp(index, 0, len(stepSizeTable)-1)
			c.adpcmPrev = clamp(prev, -32768, 32767)
			c.adpcmMu.Unlock()
		}
	}
}

func (c *Client) processSND(body []byte) ([]byte, bool) {
	if len(body) < 7 {
		return nil, false
	}

	flags := body[0]
	audio := body[7:]
	if len(audio) == 0 {
		return nil, false
	}

	if flags&SND_FLAG_STEREO != 0 && len(audio) >= 10 {
		audio = audio[10:]
	}

	if flags&SND_FLAG_COMPRESSED != 0 {
		return c.decodeIMAADPCM(audio), true
	}

	return endianToLittlePCM(audio, flags&SND_FLAG_LITTLE_ENDIAN != 0), true
}

func sanitizeName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "sdr-radio"
	}
	name = strings.ReplaceAll(name, " ", "_")
	return name
}

const (
	SND_FLAG_STEREO        = 0x08
	SND_FLAG_COMPRESSED    = 0x10
	SND_FLAG_LITTLE_ENDIAN = 0x80
)

var stepSizeTable = []int{
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
	19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
	50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
	130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
	337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
	876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
	2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
	5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
	15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
}

var indexAdjustTable = []int{
	-1, -1, -1, -1, 2, 4, 6, 8,
	-1, -1, -1, -1, 2, 4, 6, 8,
}

func (c *Client) decodeIMAADPCM(data []byte) []byte {
	c.adpcmMu.Lock()
	defer c.adpcmMu.Unlock()

	out := make([]byte, 0, len(data)*4)
	for _, b := range data {
		lo := b & 0x0F
		hi := (b >> 4) & 0x0F
		s0 := c.decodeADPCMNibble(int(lo))
		s1 := c.decodeADPCMNibble(int(hi))

		var two [4]byte
		binary.LittleEndian.PutUint16(two[0:2], uint16(int16(s0)))
		binary.LittleEndian.PutUint16(two[2:4], uint16(int16(s1)))
		out = append(out, two[:]...)
	}
	return out
}

func (c *Client) decodeADPCMNibble(code int) int {
	step := stepSizeTable[c.adpcmIndex]
	c.adpcmIndex = clamp(c.adpcmIndex+indexAdjustTable[code], 0, len(stepSizeTable)-1)

	diff := step >> 3
	if code&1 != 0 {
		diff += step >> 2
	}
	if code&2 != 0 {
		diff += step >> 1
	}
	if code&4 != 0 {
		diff += step
	}
	if code&8 != 0 {
		diff = -diff
	}
	c.adpcmPrev = clamp(c.adpcmPrev+diff, -32768, 32767)
	return c.adpcmPrev
}

func clamp(v, minV, maxV int) int {
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

func endianToLittlePCM(data []byte, littleEndian bool) []byte {
	if littleEndian {
		out := make([]byte, len(data))
		copy(out, data)
		return out
	}

	out := make([]byte, len(data))
	copy(out, data)
	for i := 0; i+1 < len(out); i += 2 {
		out[i], out[i+1] = out[i+1], out[i]
	}
	return out
}
