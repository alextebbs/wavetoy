package kiwi

import (
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestConnect_UsesSNDPathAndNegotiatesAudioRate(t *testing.T) {
	t.Parallel()

	receivedText := make(chan string, 64)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/SND") {
			t.Errorf("expected websocket path to end with /SND, got %q", r.URL.Path)
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade: %v", err)
		}
		defer conn.Close()

		readDone := make(chan struct{})
		go func() {
			defer close(readDone)
			for {
				mt, payload, err := conn.ReadMessage()
				if err != nil {
					return
				}
				if mt == websocket.TextMessage {
					receivedText <- string(payload)
				}
			}
		}()

		msgPayload := append([]byte{0}, []byte("sample_rate=12000 audio_rate=12000 audio_adpcm_state=0,0")...)
		if err := conn.WriteMessage(websocket.BinaryMessage, append([]byte("MSG"), msgPayload...)); err != nil {
			t.Fatalf("write MSG: %v", err)
		}

		_ = waitForText(t, receivedText, "SET auth t=kiwi p=")
		_ = waitForText(t, receivedText, "SET ident_user=integration-test")
		_ = waitForText(t, receivedText, "SET run=1")
		_ = waitForText(t, receivedText, "SET AR OK in=12000 out=12000")

		select {
		case <-readDone:
		case <-time.After(500 * time.Millisecond):
		}
	}))
	defer server.Close()

	host, port := parseHostPort(t, server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client, err := Connect(ctx, Config{
		Host:          host,
		Port:          port,
		UseTLS:        false,
		Name:          "integration test",
		FrequencyKHz:  7039.0,
		Mode:          "am",
		BandwidthLoHz: -5000,
		BandwidthHiHz: 5000,
		AGCOn:         true,
	}, 0, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()
}

func TestConnect_DecodesCompressedAndBigEndianSND(t *testing.T) {
	t.Parallel()

	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade: %v", err)
		}
		defer conn.Close()

		// Drain client text messages in background.
		go func() {
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		}()

		msgPayload := append([]byte{0}, []byte("sample_rate=12000 audio_adpcm_state=0,0")...)
		if err := conn.WriteMessage(websocket.BinaryMessage, append([]byte("MSG"), msgPayload...)); err != nil {
			t.Fatalf("write MSG: %v", err)
		}

		// Compressed SND. ADPCM byte 0x00 decodes to two 16-bit zero samples.
		if err := conn.WriteMessage(websocket.BinaryMessage, makeSNDFrame(SND_FLAG_COMPRESSED, []byte{0x00})); err != nil {
			t.Fatalf("write compressed SND: %v", err)
		}

		// Uncompressed big-endian SND containing samples 0x1234 and 0xABCD.
		if err := conn.WriteMessage(websocket.BinaryMessage, makeSNDFrame(0x00, []byte{0x12, 0x34, 0xAB, 0xCD})); err != nil {
			t.Fatalf("write uncompressed SND: %v", err)
		}

		time.Sleep(300 * time.Millisecond)
	}))
	defer server.Close()

	host, port := parseHostPort(t, server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client, err := Connect(ctx, Config{
		Host:          host,
		Port:          port,
		UseTLS:        false,
		Name:          "decode-test",
		FrequencyKHz:  7039.0,
		Mode:          "am",
		BandwidthLoHz: -5000,
		BandwidthHiHz: 5000,
		AGCOn:         true,
	}, 0, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	gotCompressed := waitForSamples(t, client.Samples())
	if len(gotCompressed) != 4 {
		t.Fatalf("expected 4 bytes from compressed frame, got %d", len(gotCompressed))
	}
	if string(gotCompressed) != string([]byte{0x00, 0x00, 0x00, 0x00}) {
		t.Fatalf("unexpected decoded compressed PCM: %v", gotCompressed)
	}

	gotBigEndian := waitForSamples(t, client.Samples())
	wantLittle := []byte{0x34, 0x12, 0xCD, 0xAB}
	if string(gotBigEndian) != string(wantLittle) {
		t.Fatalf("expected little-endian PCM %v, got %v", wantLittle, gotBigEndian)
	}
}

func makeSNDFrame(flags byte, audio []byte) []byte {
	body := make([]byte, 7+len(audio))
	body[0] = flags
	binary.LittleEndian.PutUint32(body[1:5], 1) // sequence
	binary.BigEndian.PutUint16(body[5:7], 1000) // s-meter
	copy(body[7:], audio)
	return append([]byte("SND"), body...)
}

func parseHostPort(t *testing.T, serverURL string) (string, int) {
	t.Helper()
	u, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	host := u.Hostname()
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}
	return host, port
}

func waitForText(t *testing.T, messages <-chan string, want string) string {
	t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case msg := <-messages:
			if strings.Contains(msg, want) {
				return msg
			}
		case <-timeout:
			t.Fatalf("did not receive expected message: %q", want)
		}
	}
}

func waitForSamples(t *testing.T, samples <-chan []byte) []byte {
	t.Helper()
	select {
	case s, ok := <-samples:
		if !ok {
			t.Fatal("samples channel closed")
		}
		return s
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for samples")
		return nil
	}
}
