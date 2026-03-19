package s3

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type Client struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
	prefix    string
}

// NewFromEnv creates an S3 client from environment variables.
// Returns nil if the required env vars are not set.
func NewFromEnv() *Client {
	endpoint := os.Getenv("AWS_ENDPOINT_URL_S3")
	accessKey := os.Getenv("AWS_ACCESS_KEY_ID")
	secretKey := os.Getenv("AWS_SECRET_ACCESS_KEY")
	bucket := os.Getenv("BUCKET_NAME")
	prefix := os.Getenv("S3_KEY_PREFIX")

	if endpoint == "" || accessKey == "" || secretKey == "" || bucket == "" {
		return nil
	}
	if prefix == "" {
		prefix = "dev"
	}

	cfg := aws.Config{
		Region:      "auto",
		Credentials: credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.UsePathStyle = true
	})

	return &Client{
		client:    client,
		presigner: s3.NewPresignClient(client),
		bucket:    bucket,
		prefix:    prefix,
	}
}

func (c *Client) Prefix() string { return c.prefix }
func (c *Client) Bucket() string { return c.bucket }

func (c *Client) EnsureBucket(ctx context.Context) {
	_, err := c.client.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: aws.String(c.bucket),
	})
	if err == nil {
		return
	}
	_, createErr := c.client.CreateBucket(ctx, &s3.CreateBucketInput{
		Bucket: aws.String(c.bucket),
	})
	if createErr != nil {
		slog.Warn("s3: create bucket failed (may already exist)", "bucket", c.bucket, "err", createErr)
	} else {
		slog.Info("s3: created bucket", "bucket", c.bucket)
	}
}

func (c *Client) PutObject(ctx context.Context, key string, body io.Reader, contentType string) error {
	_, err := c.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		Body:        body,
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return fmt.Errorf("s3 put %s: %w", key, err)
	}
	return nil
}

func (c *Client) PreSignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	resp, err := c.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("s3 presign %s: %w", key, err)
	}
	return resp.URL, nil
}

func (c *Client) GetObject(ctx context.Context, key string) (io.ReadCloser, string, error) {
	resp, err := c.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, "", fmt.Errorf("s3 get %s: %w", key, err)
	}
	ct := "application/octet-stream"
	if resp.ContentType != nil {
		ct = *resp.ContentType
	}
	return resp.Body, ct, nil
}

func (c *Client) DeletePrefix(ctx context.Context, prefix string) error {
	paginator := s3.NewListObjectsV2Paginator(c.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(c.bucket),
		Prefix: aws.String(prefix),
	})

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("s3 list %s: %w", prefix, err)
		}
		if len(page.Contents) == 0 {
			continue
		}

		objects := make([]s3types.ObjectIdentifier, len(page.Contents))
		for i, obj := range page.Contents {
			objects[i] = s3types.ObjectIdentifier{Key: obj.Key}
		}

		_, err = c.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(c.bucket),
			Delete: &s3types.Delete{Objects: objects, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return fmt.Errorf("s3 delete batch: %w", err)
		}
	}
	return nil
}
