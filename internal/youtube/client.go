// Package youtube provides a small read-only YouTube REST client.
package youtube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const DefaultBaseURL = "https://www.googleapis.com/youtube/v3"

type TokenSource func(context.Context, bool) (string, error)

type Client struct {
	BaseURL     string
	APIKey      string
	TokenSource TokenSource
	HTTPClient  *http.Client
	MaxRetries  int
	Sleep       func(context.Context, time.Duration) error
}

type Response struct {
	Items                 []map[string]any `json:"items"`
	NextPageToken         string           `json:"nextPageToken,omitempty"`
	PrevPageToken         string           `json:"prevPageToken,omitempty"`
	PollingIntervalMillis int64            `json:"pollingIntervalMillis,omitempty"`
	OfflineAt             string           `json:"offlineAt,omitempty"`
	PageInfo              map[string]any   `json:"pageInfo,omitempty"`
	Kind                  string           `json:"kind,omitempty"`
	ETag                  string           `json:"etag,omitempty"`
}

type APIError struct {
	HTTPStatus int
	Code       int
	Message    string
	Reasons    []string
}

func (e *APIError) Error() string {
	if len(e.Reasons) > 0 {
		return fmt.Sprintf("YouTube API error (%d, %s): %s", e.Code, strings.Join(e.Reasons, ", "), e.Message)
	}
	return fmt.Sprintf("YouTube API error (%d): %s", e.Code, e.Message)
}

func NewClient(key string, timeout time.Duration) *Client {
	return &Client{
		BaseURL:    DefaultBaseURL,
		APIKey:     key,
		HTTPClient: &http.Client{Timeout: timeout},
		MaxRetries: 3,
		Sleep:      sleepContext,
	}
}

func (c *Client) Get(ctx context.Context, resource string, params url.Values) (Response, error) {
	var out Response
	if err := c.GetJSON(ctx, resource, params, true, &out); err != nil {
		return Response{}, err
	}
	return out, nil
}

func (c *Client) GetJSON(ctx context.Context, resource string, params url.Values, authenticate bool, out any) error {
	base := strings.TrimRight(c.BaseURL, "/")
	resource = strings.TrimLeft(resource, "/")
	target := base + "/" + resource
	if encoded := params.Encode(); encoded != "" {
		target += "?" + encoded
	}

	transientAttempt := 0
	authRetried := false
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "oytc/0.1")
		if authenticate {
			switch {
			case c.TokenSource != nil:
				token, err := c.TokenSource(ctx, false)
				if err != nil {
					return err
				}
				if strings.TrimSpace(token) == "" {
					return ErrMissingOAuth
				}
				req.Header.Set("Authorization", "Bearer "+token)
			case strings.TrimSpace(c.APIKey) != "":
				req.Header.Set("X-Goog-Api-Key", c.APIKey)
			default:
				return ErrMissingKey
			}
		}
		resp, err := c.httpClient().Do(req)
		if err != nil {
			if !retryableTransport(err) || transientAttempt >= c.MaxRetries {
				return fmt.Errorf("request YouTube API: %w", err)
			}
			if err := c.wait(ctx, backoff(transientAttempt, "")); err != nil {
				return err
			}
			transientAttempt++
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("read YouTube API response: %w", readErr)
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			if authenticate && c.TokenSource != nil && resp.StatusCode == http.StatusUnauthorized && !authRetried {
				if _, err := c.TokenSource(ctx, true); err != nil {
					return err
				}
				authRetried = true
				continue
			}
			apiErr := parseAPIError(resp.StatusCode, body)
			if isTransientStatus(resp.StatusCode) && transientAttempt < c.MaxRetries {
				if err := c.wait(ctx, backoff(transientAttempt, resp.Header.Get("Retry-After"))); err != nil {
					return err
				}
				transientAttempt++
				continue
			}
			return apiErr
		}
		decoder := json.NewDecoder(strings.NewReader(string(body)))
		decoder.UseNumber()
		if err := decoder.Decode(out); err != nil {
			return fmt.Errorf("decode YouTube API response: %w", err)
		}
		return nil
	}
}

var (
	ErrMissingKey   = errors.New("no API key configured; run 'oytc login' or set OYTC_API_KEY")
	ErrMissingOAuth = errors.New("no OAuth credentials configured; run 'oytc login --oauth'")
)

func parseAPIError(status int, body []byte) *APIError {
	var envelope struct {
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Errors  []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
			Details []struct {
				Reason string `json:"reason"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &envelope)
	e := &APIError{HTTPStatus: status, Code: envelope.Error.Code, Message: envelope.Error.Message}
	if e.Code == 0 {
		e.Code = status
	}
	if e.Message == "" {
		e.Message = http.StatusText(status)
	}
	for _, item := range envelope.Error.Errors {
		if item.Reason != "" {
			e.Reasons = append(e.Reasons, item.Reason)
		}
	}
	for _, item := range envelope.Error.Details {
		if item.Reason != "" {
			e.Reasons = append(e.Reasons, item.Reason)
		}
	}
	return e
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (c *Client) wait(ctx context.Context, d time.Duration) error {
	if c.Sleep != nil {
		return c.Sleep(ctx, d)
	}
	return sleepContext(ctx, d)
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func retryableTransport(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) || errors.Is(err, io.EOF)
}

func isTransientStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == 500 || status == 502 || status == 503 || status == 504
}

func backoff(attempt int, retryAfter string) time.Duration {
	if seconds, err := strconv.Atoi(retryAfter); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	base := time.Duration(1<<attempt) * 250 * time.Millisecond
	return base + time.Duration(rand.IntN(150))*time.Millisecond
}
