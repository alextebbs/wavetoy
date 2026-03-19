package startup

import (
	"context"
	"log/slog"

	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/fallback"
	"github.com/sammy/sdr-radio/internal/streammgr"
)

type Deps struct {
	DB          *db.DB
	StreamMgr   *streammgr.Manager
	FallbackMgr *fallback.Manager
}

// Run executes all post-boot startup tasks in a background goroutine.
// It should be called once, after all wiring is complete.
func Run(ctx context.Context, d Deps) {
	go run(ctx, d)
}

func run(ctx context.Context, d Deps) {
	streams, err := d.DB.ListStreamsByTenant(ctx, db.DefaultTenantID, 100, 0)
	if err != nil {
		slog.Error("startup: list streams", "err", err)
		return
	}

	for _, stream := range streams {
		if stream.AutoProbe {
			d.FallbackMgr.Enable(ctx, stream.ID)
		}

		if stream.KeepAlive {
			slog.Info("startup: auto-connecting keep-alive stream", "stream", stream.ID, "source", stream.SourceID)
			if err := d.StreamMgr.EnsureRunning(ctx, stream); err != nil {
				slog.Error("startup: keep-alive connect failed", "stream", stream.ID, "err", err)
			}
		}
	}
}
