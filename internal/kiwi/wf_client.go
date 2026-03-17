package kiwi

import (
	"context"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sammy/sdr-radio/internal/streamlog"
)

type WFConfig struct {
	Host      string
	Port      int
	UseTLS    bool
	Name      string
	Zoom      int
	CenterKHz float64
	Speed     int
	Compress  bool
}

type WFFrame struct {
	Bins  []byte
	XBin  uint32
	Zoom  uint16
	Flags uint16
}

type WFClient struct {
	conn  *websocket.Conn
	label string
	logFn LogFunc

	closeOnce sync.Once
	writeMu   sync.Mutex

	done   chan struct{}
	frames chan WFFrame

	framesIn       atomic.Int64
	firstLogged    atomic.Bool
	maxFreqKHz     atomic.Int64
}

const (
	WF_FLAG_COMPRESSED = 0x01
	WF_BINS            = 1024
)

func ConnectWF(ctx context.Context, cfg WFConfig, timestamp int64, logFn LogFunc) (*WFClient, error) {
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
		Path:   fmt.Sprintf("/%d/W/F", timestamp),
	}

	label := fmt.Sprintf("%s:%d/WF", cfg.Host, cfg.Port)
	if logFn != nil {
		logFn(streamlog.LevelDebug, "dial", "wavetoy", "kiwi", fmt.Sprintf("wf endpoint=%s", endpoint.String()))
	}

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.DialContext(ctx, endpoint.String(), nil)
	if err != nil {
		if logFn != nil {
			logFn(streamlog.LevelDebug, "dial", "wavetoy", "kiwi", fmt.Sprintf("wf failed: %v", err))
		}
		return nil, err
	}

	client := &WFClient{
		conn:   conn,
		label:  label,
		logFn:  logFn,
		done:   make(chan struct{}),
		frames: make(chan WFFrame, 32),
	}
	client.maxFreqKHz.Store(30000)

	if err := client.init(cfg); err != nil {
		client.Close()
		return nil, err
	}

	go client.readLoop()
	go client.keepAliveLoop()
	return client, nil
}

func (c *WFClient) Frames() <-chan WFFrame {
	return c.frames
}

func (c *WFClient) Done() <-chan struct{} {
	return c.done
}

func (c *WFClient) MaxFreqKHz() int64 {
	return c.maxFreqKHz.Load()
}

func (c *WFClient) Close() error {
	var closeErr error
	c.closeOnce.Do(func() {
		close(c.done)
		closeErr = c.conn.Close()
		close(c.frames)
	})
	return closeErr
}

func (c *WFClient) init(cfg WFConfig) error {
	cmds := buildWFInitCommands(cfg)
	for _, cmd := range cmds {
		if err := c.send(cmd); err != nil {
			return err
		}
	}
	return nil
}

func (c *WFClient) Reconfigure(zoom int, centerKHz float64, speed int) error {
	cmds := []string{
		fmt.Sprintf("SET zoom=%d cf=%.3f", zoom, centerKHz),
		fmt.Sprintf("SET wf_speed=%d", speed),
	}
	for _, cmd := range cmds {
		if err := c.send(cmd); err != nil {
			return err
		}
	}
	return nil
}

func buildWFInitCommands(cfg WFConfig) []string {
	speed := cfg.Speed
	if speed < 1 || speed > 4 {
		speed = 4
	}
	zoom := cfg.Zoom
	if zoom < 0 {
		zoom = 0
	}
	if zoom > 14 {
		zoom = 14
	}
	centerKHz := cfg.CenterKHz
	if centerKHz <= 0 {
		centerKHz = 15000.0
	}

	return []string{
		"SET auth t=kiwi p=",
		fmt.Sprintf("SET ident_user=%s", sanitizeName(cfg.Name)),
		fmt.Sprintf("SET zoom=%d cf=%.3f", zoom, centerKHz),
		"SET maxdb=-10 mindb=-110",
		fmt.Sprintf("SET wf_comp=%d", boolToIntWF(cfg.Compress)),
		fmt.Sprintf("SET wf_speed=%d", speed),
		"SET interp=13",
		"SET send_dB=1",
	}
}

func boolToIntWF(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (c *WFClient) readLoop() {
	defer c.Close()

	for {
		msgType, payload, err := c.conn.ReadMessage()
		if err != nil {
			if c.logFn != nil {
				c.logFn(streamlog.LevelWarn, "kiwi.wf.read.exit", "kiwi", "wavetoy",
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
		case "W/F":
			frame, ok := c.processWF(body)
			if !ok {
				continue
			}
			select {
			case c.frames <- frame:
			default:
			}
		}
	}
}

func (c *WFClient) processWF(body []byte) (WFFrame, bool) {
	if len(body) < 13 {
		return WFFrame{}, false
	}
	body = body[1:]

	xBin := binary.LittleEndian.Uint32(body[0:4])
	zoomFlags := binary.LittleEndian.Uint32(body[4:8])
	zoom := uint16(zoomFlags & 0xFFFF)
	flags := uint16((zoomFlags >> 16) & 0xFFFF)
	bins := make([]byte, len(body[12:]))
	copy(bins, body[12:])

	if c.firstLogged.CompareAndSwap(false, true) {
		if c.logFn != nil {
			c.logFn(streamlog.LevelDebug, "kiwi.wf.first", "kiwi", "wavetoy",
				fmt.Sprintf("bins=%d xbin=%d zoom=%d flags=0x%04x", len(bins), xBin, zoom, flags))
		}
	}
	c.framesIn.Add(1)

	return WFFrame{Bins: bins, XBin: xBin, Zoom: zoom, Flags: flags}, true
}

func (c *WFClient) processMSG(body []byte) {
	if len(body) == 0 {
		return
	}
	text := string(body[1:])
	for _, pair := range strings.Split(text, " ") {
		if !strings.Contains(pair, "=") {
			continue
		}
		name, value, _ := strings.Cut(pair, "=")
		switch name {
		case "bandwidth":
			var bw float64
			if _, err := fmt.Sscanf(value, "%f", &bw); err == nil && bw > 0 {
				c.maxFreqKHz.Store(int64(bw / 1000))
				if c.logFn != nil {
					c.logFn(streamlog.LevelDebug, "kiwi.bandwidth", "kiwi", "wavetoy",
						fmt.Sprintf("bandwidth=%dkHz", c.maxFreqKHz.Load()))
				}
			}
		}
	}
}

func (c *WFClient) keepAliveLoop() {
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

func (c *WFClient) send(cmd string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if cmd != "SET keepalive" && c.logFn != nil {
		c.logFn(streamlog.LevelDebug, "kiwi.cmd", "wavetoy", "kiwi", cmd)
	}
	return c.conn.WriteMessage(websocket.TextMessage, []byte(cmd))
}
