package ops

import "testing"

func TestValidateRequestedItemsHandlesDuplicatesAcrossBatches(t *testing.T) {
	requested := make([]string, 51)
	for index := range requested {
		requested[index] = "present"
	}
	requested = append(requested, "missing")
	items := []map[string]any{{"id": "present"}, {"id": "present"}}
	if err := validateRequestedItems("videos", requested, items); err == nil || err.Error() != "videos not found: missing" {
		t.Fatalf("error = %v", err)
	}
}
