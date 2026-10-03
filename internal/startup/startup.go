package startup

import (
	"context"
	"log/slog"

	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/probe"
	"github.com/sammy/sdr-radio/internal/streammgr"
)

type Deps struct {
	DB          *db.DB
	StreamMgr   *streammgr.Manager
	ProbeMgr *probe.Manager
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
		if stream.AutoProbe || stream.QualityFallback {
			d.ProbeMgr.Enable(ctx, stream.ID)
		}

		shouldConnect := stream.KeepAlive || stream.QualityFallback
		if shouldConnect {
			slog.Info("startup: auto-connecting stream", "stream", stream.ID, "source", stream.SourceID,
				"keep_alive", stream.KeepAlive, "quality_fallback", stream.QualityFallback)
			if err := d.StreamMgr.EnsureRunning(ctx, stream); err != nil {
				slog.Error("startup: auto-connect failed", "stream", stream.ID, "err", err)
			}
		}

		if stream.QualityFallback {
			d.StreamMgr.SetQualityFallback(stream.ID, true, stream)
		}
	}
}
