package mcpauth

// Client ID metadata documents: a client_id that is an https URL names a
// JSON document, served by the client, describing it.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"open-yt-cli/internal/store"
)

const (
	documentTimeout = 5 * time.Second
	documentTTL     = time.Hour
	maxDocumentSize = 64 << 10
)

type documents struct {
	client *http.Client
	now    func() time.Time

	mu    sync.Mutex
	cache map[string]cachedDocument
}

type cachedDocument struct {
	client  store.OAuthClient
	expires time.Time
}

func newDocuments(client *http.Client, now func() time.Time) *documents {
	return &documents{client: client, now: now, cache: map[string]cachedDocument{}}
}

// get returns the client a metadata document describes, fetching the
// document at most once an hour.
func (d *documents) get(ctx context.Context, clientID string) (store.OAuthClient, error) {
	d.mu.Lock()
	cached, ok := d.cache[clientID]
	d.mu.Unlock()
	if ok && d.now().Before(cached.expires) {
		return cached.client, nil
	}
	client, err := d.fetch(ctx, clientID)
	if err != nil {
		return store.OAuthClient{}, err
	}
	d.mu.Lock()
	d.cache[clientID] = cachedDocument{client: client, expires: d.now().Add(documentTTL)}
	d.mu.Unlock()
	return client, nil
}

func (d *documents) fetch(ctx context.Context, clientID string) (store.OAuthClient, error) {
	u, err := url.Parse(clientID)
	if err != nil || u.Scheme != "https" || u.Host == "" || strings.Trim(u.Path, "/") == "" || u.User != nil || strings.Contains(clientID, "#") {
		return store.OAuthClient{}, errors.New("client_id must be an https URL with a path")
	}
	ctx, cancel := context.WithTimeout(ctx, documentTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	if err != nil {
		return store.OAuthClient{}, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := d.client.Do(req)
	if err != nil {
		return store.OAuthClient{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return store.OAuthClient{}, fmt.Errorf("fetching it returned %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDocumentSize+1))
	if err != nil {
		return store.OAuthClient{}, err
	}
	if len(body) > maxDocumentSize {
		return store.OAuthClient{}, errors.New("it is larger than 64 KB")
	}
	var doc struct {
		ClientID     string   `json:"client_id"`
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return store.OAuthClient{}, fmt.Errorf("it is not a JSON object: %w", err)
	}
	if doc.ClientID != clientID {
		return store.OAuthClient{}, errors.New("its client_id does not match its URL")
	}
	if err := checkRedirectURIs(doc.RedirectURIs); err != nil {
		return store.OAuthClient{}, err
	}
	return store.OAuthClient{ID: clientID, Name: label(doc.ClientName, u.Hostname()), RedirectURIs: doc.RedirectURIs}, nil
}

// publicClient fetches metadata documents from the public internet only: it
// dials public IP addresses alone, uses no proxy, and follows no redirects.
func publicClient() *http.Client {
	dialer := &net.Dialer{Timeout: documentTimeout, Control: dialPublic}
	return &http.Client{
		Transport:     &http.Transport{DialContext: dialer.DialContext, TLSHandshakeTimeout: documentTimeout},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       documentTimeout,
	}
}

// nonPublic adds the ranges netip has no predicate for: "this network" and
// carrier-grade NAT.
var nonPublic = []netip.Prefix{netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10")}

// dialPublic refuses loopback, private, link-local, multicast, and other
// non-public addresses. It runs after DNS resolution, so a public name that
// resolves to a private address is refused too.
func dialPublic(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return err
	}
	ip = ip.Unmap()
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.IsUnspecified() ||
		slices.ContainsFunc(nonPublic, func(prefix netip.Prefix) bool { return prefix.Contains(ip) }) {
		return fmt.Errorf("%s is not a public address", ip)
	}
	return nil
}
