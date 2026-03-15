package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"text/tabwriter"

	"github.com/joho/godotenv"
	"github.com/sammy/sdr-radio/internal/auth"
	"github.com/sammy/sdr-radio/internal/db"
)

func main() {
	list := flag.Bool("list", false, "list all tenants")
	name := flag.String("name", "", "tenant display name (required for creation)")
	passphrase := flag.String("passphrase", "", "tenant passphrase (required for creation)")
	maxStreams := flag.Int("max-streams", 5, "max concurrent streams for this tenant")
	flag.Parse()

	_ = godotenv.Load()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://localhost:5432/sdrradio?sslmode=disable"
	}

	ctx := context.Background()
	database, err := db.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer database.Close()

	if *list {
		tenants, err := database.ListTenants(ctx)
		if err != nil {
			log.Fatalf("list tenants: %v", err)
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tNAME\tMAX_STREAMS\tCREATED_AT")
		for _, t := range tenants {
			fmt.Fprintf(w, "%s\t%s\t%d\t%s\n", t.ID, t.Name, t.MaxStreams, t.CreatedAt.Format("2006-01-02 15:04:05"))
		}
		w.Flush()
		return
	}

	if *name == "" || *passphrase == "" {
		fmt.Fprintln(os.Stderr, "Usage: create-tenant --name NAME --passphrase PASS [--max-streams N]")
		fmt.Fprintln(os.Stderr, "       create-tenant --list")
		os.Exit(1)
	}

	hash, err := auth.HashPassphrase(*passphrase)
	if err != nil {
		log.Fatalf("hash passphrase: %v", err)
	}

	tenant, err := database.CreateTenant(ctx, db.CreateTenantParams{
		Name:            *name,
		MagicPhraseHash: hash,
		MaxStreams:       *maxStreams,
	})
	if err != nil {
		log.Fatalf("create tenant: %v", err)
	}

	fmt.Printf("created tenant %s (%s) with max_streams=%d\n", tenant.ID, tenant.Name, tenant.MaxStreams)
}
