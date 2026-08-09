package main

import (
	"context"
	"net/http"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
)

// Authenticator handles GitHub OAuth device flow authentication.
type Authenticator interface {
	RequestCode(ctx context.Context, scopes []string) (*device.CodeResponse, error)
	Wait(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error)
}

// deviceFlowAuthenticator is the OAuth device-flow Authenticator used by init.
// The fork/clone phase (and its GitHubClient API port) was removed with the
// repo-mount restructure — init only needs the device flow to mint a token.
type deviceFlowAuthenticator struct {
	clientID   string
	httpClient *http.Client
}

// NewAuthenticator creates a device flow authenticator with the given GitHub OAuth client ID.
func NewAuthenticator(clientID string) Authenticator {
	return &deviceFlowAuthenticator{
		clientID:   clientID,
		httpClient: http.DefaultClient,
	}
}

func (a *deviceFlowAuthenticator) RequestCode(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
	return device.RequestCode(
		a.httpClient,
		"https://github.com/login/device/code",
		a.clientID,
		scopes,
	)
}

func (a *deviceFlowAuthenticator) Wait(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
	return device.Wait(ctx, a.httpClient, "https://github.com/login/oauth/access_token", device.WaitOptions{
		ClientID:   a.clientID,
		DeviceCode: code,
	})
}
