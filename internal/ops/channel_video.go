package ops

import (
	"cmp"
	"context"
	"fmt"
	"net/url"

	"open-yt-cli/internal/youtube"
)

type ChannelGetInput struct {
	Refs []string `json:"refs" jsonschema:"channel IDs (UC…), @handles, or channel URLs"`
	API
	HL string `json:"hl,omitempty" jsonschema:"localization language code"`
}

func ChannelGet(ctx context.Context, data DataClient, in ChannelGetInput) (youtube.ListResult, error) {
	parts := partsOr(in.Parts, "snippet,contentDetails,statistics")
	if err := firstError(
		invalidIf(len(in.Refs) == 0, "refs must contain at least one channel"),
		validateParts(parts, "auditDetails", "contentOwnerDetails"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	client, err := data(ctx)
	if err != nil {
		return youtube.ListResult{}, err
	}
	ids := make([]string, 0, len(in.Refs))
	requests := 0
	for _, reference := range in.Refs {
		id, used, err := client.ResolveChannel(ctx, reference)
		requests += used
		if err != nil {
			return youtube.ListResult{}, err
		}
		ids = append(ids, id)
	}
	params := url.Values{"part": {parts}}
	setValues(params, map[string]string{"hl": in.HL})
	result, err := getByIDs(ctx, client, "channels", ids, 50, params, in.Fields)
	result.Requests += requests
	return result, err
}

type ChannelActivitiesInput struct {
	Channel         string `json:"channel" jsonschema:"channel ID, @handle, or channel URL"`
	PublishedAfter  string `json:"publishedAfter,omitempty" jsonschema:"RFC 3339 lower publication bound"`
	PublishedBefore string `json:"publishedBefore,omitempty" jsonschema:"RFC 3339 upper publication bound"`
	Page
	API
}

func ChannelActivities(ctx context.Context, data DataClient, in ChannelActivitiesInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 25)
	if err := firstError(
		in.Page.validate(50),
		validateTimestamp("publishedAfter", in.PublishedAfter),
		validateTimestamp("publishedBefore", in.PublishedBefore),
	); err != nil {
		return youtube.ListResult{}, err
	}
	client, err := data(ctx)
	if err != nil {
		return youtube.ListResult{}, err
	}
	channelID, requests, err := client.ResolveChannel(ctx, in.Channel)
	if err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet,contentDetails")}, "channelId": {channelID}}
	setValues(params, map[string]string{"publishedAfter": in.PublishedAfter, "publishedBefore": in.PublishedBefore, "fields": in.Fields})
	result, err := client.List(ctx, "activities", params, pageOptions(in.Page))
	result.Requests += requests
	return result, err
}

type ChannelSectionsInput struct {
	Channel string `json:"channel,omitempty" jsonschema:"channel ID, @handle, or channel URL"`
	ID      string `json:"id,omitempty" jsonschema:"comma-separated channel section IDs"`
	API
	HL string `json:"hl,omitempty" jsonschema:"localization language code"`
}

func ChannelSections(ctx context.Context, data DataClient, in ChannelSectionsInput) (youtube.ListResult, error) {
	if (in.ID == "") == (in.Channel == "") {
		return youtube.ListResult{}, &InputError{Message: "provide exactly one of channel or id"}
	}
	client, err := data(ctx)
	if err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet,contentDetails")}}
	requests := 0
	if in.ID != "" {
		params.Set("id", in.ID)
	} else {
		channelID, used, err := client.ResolveChannel(ctx, in.Channel)
		if err != nil {
			return youtube.ListResult{}, err
		}
		requests += used
		params.Set("channelId", channelID)
	}
	setValues(params, map[string]string{"hl": in.HL, "fields": in.Fields})
	response, err := client.Get(ctx, "channelSections", params)
	if err != nil {
		return youtube.ListResult{}, err
	}
	return youtube.ListResult{Items: response.Items, Requests: requests + 1}, nil
}

type ChannelUploadsInput struct {
	Channel string `json:"channel" jsonschema:"channel ID, @handle, or channel URL"`
	Page
	API
}

func ChannelUploads(ctx context.Context, data DataClient, in ChannelUploadsInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 50)
	if err := in.Page.validate(50); err != nil {
		return youtube.ListResult{}, err
	}
	client, err := data(ctx)
	if err != nil {
		return youtube.ListResult{}, err
	}
	channelID, requests, err := client.ResolveChannel(ctx, in.Channel)
	if err != nil {
		return youtube.ListResult{}, err
	}
	channelResponse, err := client.Get(ctx, "channels", url.Values{"part": {"contentDetails"}, "id": {channelID}})
	if err != nil {
		return youtube.ListResult{}, err
	}
	requests++
	if len(channelResponse.Items) == 0 {
		return youtube.ListResult{}, fmt.Errorf("channel %q not found", in.Channel)
	}
	uploads, ok := mapPathString(channelResponse.Items[0], "contentDetails", "relatedPlaylists", "uploads")
	if !ok || uploads == "" {
		return youtube.ListResult{}, fmt.Errorf("channel %q has no public uploads playlist", in.Channel)
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet,contentDetails")}, "playlistId": {uploads}}
	setValues(params, map[string]string{"fields": in.Fields})
	result, err := client.List(ctx, "playlistItems", params, pageOptions(in.Page))
	result.Requests += requests
	return result, err
}

type VideoGetInput struct {
	IDs []string `json:"ids" jsonschema:"video IDs; up to 50 cost one request"`
	API
	HL string `json:"hl,omitempty" jsonschema:"localization language code"`
}

func VideoGet(ctx context.Context, data DataClient, in VideoGetInput) (youtube.ListResult, error) {
	return videos(ctx, data, in, "snippet,contentDetails,statistics,status")
}

// VideoStats is VideoGet defaulting to the statistics part.
func VideoStats(ctx context.Context, data DataClient, in VideoGetInput) (youtube.ListResult, error) {
	return videos(ctx, data, in, "statistics")
}

func videos(ctx context.Context, data DataClient, in VideoGetInput, defaultParts string) (youtube.ListResult, error) {
	parts := partsOr(in.Parts, defaultParts)
	if err := firstError(
		invalidIf(len(in.IDs) == 0, "ids must contain at least one video ID"),
		validateParts(parts, "fileDetails", "processingDetails", "suggestions"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	client, err := data(ctx)
	if err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {parts}}
	setValues(params, map[string]string{"hl": in.HL})
	return getByIDs(ctx, client, "videos", in.IDs, 50, params, in.Fields)
}

type VideoPopularInput struct {
	Region   string `json:"region,omitempty" jsonschema:"ISO 3166-1 alpha-2 chart region (default US)"`
	Category string `json:"category,omitempty" jsonschema:"video category ID"`
	Page
	API
	HL string `json:"hl,omitempty" jsonschema:"localization language code"`
}

func VideoPopular(ctx context.Context, data DataClient, in VideoPopularInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 25)
	in.Region = cmp.Or(in.Region, "US")
	parts := partsOr(in.Parts, "snippet,contentDetails,statistics")
	if err := firstError(
		in.Page.validate(50),
		validateParts(parts, "fileDetails", "processingDetails", "suggestions"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {parts}, "chart": {"mostPopular"}}
	setValues(params, map[string]string{"regionCode": in.Region, "videoCategoryId": in.Category, "hl": in.HL, "fields": in.Fields})
	return list(ctx, data, "videos", params, in.Page, nil)
}

type VideoTrainabilityInput struct {
	Video string `json:"video" jsonschema:"video ID"`
}

// VideoTrainability costs no quota and sends no credentials; data only
// supplies the client's endpoint and transport.
func VideoTrainability(ctx context.Context, data DataClient, in VideoTrainabilityInput) (map[string]any, error) {
	client, err := data(ctx)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := client.GetJSON(ctx, "videoTrainability", url.Values{"id": {in.Video}}, false, &result); err != nil {
		return nil, err
	}
	return result, nil
}
