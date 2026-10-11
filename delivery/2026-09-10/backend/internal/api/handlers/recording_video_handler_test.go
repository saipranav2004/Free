package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"go.uber.org/zap"
	"gorm.io/gorm"
	glogger "gorm.io/gorm/logger"

	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/services"
)

// memStorage stands in for the recording store. The route under test only
// ever calls Load, so nothing here needs a disk.
type memStorage struct{ files map[string][]byte }

func (m *memStorage) Save(_ context.Context, key string, data []byte) error {
	m.files[key] = data
	return nil
}

func (m *memStorage) Load(_ context.Context, key string) ([]byte, error) {
	data, ok := m.files[key]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	return data, nil
}

func (m *memStorage) Label() string { return "memory" }

// The real router, the real handler and a real database, driven over HTTP, so
// what is exercised is the path a browser's <video> element actually takes.
func newVideoAPI(t *testing.T, recs []models.SessionRecording, files map[string][]byte) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	dsn := "file:" + t.Name() + "?mode=memory&cache=shared&_pragma=busy_timeout(5000)"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: glogger.Discard})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&models.SessionRecording{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	for i := range recs {
		if err := db.Create(&recs[i]).Error; err != nil {
			t.Fatalf("seed recording: %v", err)
		}
	}

	h := NewAdminHandler(nil, services.NewResourceService(db, "0123456789abcdef0123456789abcdef", zap.NewNop()),
		nil, &memStorage{files: files}, zap.NewNop())

	r := gin.New()
	if err := r.SetTrustedProxies(nil); err != nil {
		t.Fatal(err)
	}
	r.GET("/api/v1/pam/admin/recordings/:id/video", h.GetRecordingVideo)
	return r
}

// The container the agent's encoder produced is carried end to end. It is not
// cosmetic: a WebM served as video/mp4 is refused outright by every browser,
// and the encoder is chosen from what the OPERATOR's ffmpeg supports, so the
// server cannot guess it. The stored key's extension is the record of it.
func TestTheVideoRouteServesTheContainerThatWasStored(t *testing.T) {
	body := []byte("\x1aE\xdf\xa3 not a real webm, but the bytes are returned verbatim")
	for _, tc := range []struct {
		name    string
		key     string
		wantCT  string
		wantExt string
	}{
		{"webm capture", "recordings/rec-webm.webm", "video/webm", ".webm"},
		{"mp4 capture", "recordings/rec-mp4.mp4", "video/mp4", ".mp4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := models.SessionRecording{
				ID: "rec-1", SessionID: "sess-1", Format: services.RecordingFormatVideo,
				StorageKey: tc.key, Status: "COMPLETED", CreatedAt: time.Now(),
			}
			r := newVideoAPI(t, []models.SessionRecording{rec}, map[string][]byte{tc.key: body})

			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/pam/admin/recordings/rec-1/video", nil))

			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
			}
			if got := w.Header().Get("Content-Type"); got != tc.wantCT {
				t.Errorf("Content-Type = %q, want %q", got, tc.wantCT)
			}
			if got := w.Body.String(); got != string(body) {
				t.Errorf("body was rewritten: %q", got)
			}
			// The download name has to match the container too, or a saved
			// copy opens in the wrong player.
			if disp := w.Header().Get("Content-Disposition"); disp != `inline; filename="rec-1`+tc.wantExt+`"` {
				t.Errorf("Content-Disposition = %q", disp)
			}
		})
	}
}

// Scrubbing a four-hour desktop session must not download four hours first,
// which is the whole reason this route goes through http.ServeContent rather
// than copying the bytes to the writer like the asciicast route does.
func TestTheVideoRouteAnswersRangeRequests(t *testing.T) {
	body := []byte("0123456789abcdefghij")
	key := "recordings/rec-1.webm"
	rec := models.SessionRecording{
		ID: "rec-1", SessionID: "sess-1", Format: services.RecordingFormatVideo,
		StorageKey: key, Status: "COMPLETED", CreatedAt: time.Now(),
	}
	r := newVideoAPI(t, []models.SessionRecording{rec}, map[string][]byte{key: body})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/pam/admin/recordings/rec-1/video", nil)
	req.Header.Set("Range", "bytes=10-14")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", w.Code)
	}
	if got := w.Body.String(); got != "abcde" {
		t.Errorf("range body = %q, want %q", got, "abcde")
	}
	if got := w.Header().Get("Content-Range"); got != "bytes 10-14/20" {
		t.Errorf("Content-Range = %q, want %q", got, "bytes 10-14/20")
	}
}

// A terminal transcript is gzip'd asciicast, not video. Serving one here would
// hand a browser a gzip stream labelled as a movie, so the route refuses
// rather than letting a caller pick the wrong content type for an artifact
// they are otherwise entitled to.
func TestTheVideoRouteRefusesAnythingThatIsNotAVideo(t *testing.T) {
	key := "recordings/rec-1.cast.gz"
	rec := models.SessionRecording{
		ID: "rec-1", SessionID: "sess-1", Format: services.RecordingFormatAsciicast,
		StorageKey: key, Status: "COMPLETED", CreatedAt: time.Now(),
	}
	r := newVideoAPI(t, []models.SessionRecording{rec}, map[string][]byte{key: []byte("gzip bytes")})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/pam/admin/recordings/rec-1/video", nil))

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", w.Code, w.Body.String())
	}
}

// A recording row exists from the moment a session starts, but its artifact
// arrives only when the session ends. Asking for the video in between must not
// be a 500.
func TestTheVideoRouteIsHonestAboutAnArtifactThatHasNotArrived(t *testing.T) {
	rec := models.SessionRecording{
		ID: "rec-1", SessionID: "sess-1", Format: services.RecordingFormatVideo,
		StorageKey: "", Status: "RECORDING", CreatedAt: time.Now(),
	}
	r := newVideoAPI(t, []models.SessionRecording{rec}, map[string][]byte{})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/pam/admin/recordings/rec-1/video", nil))

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", w.Code, w.Body.String())
	}
}
