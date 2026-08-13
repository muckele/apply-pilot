import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  directAudioMaxBytes,
  directAudioUploadsEnabled,
  interviewAudioPathPrefix,
  serverAudioMaxBytes,
  validateInterviewAudioUpload,
  validateInterviewBlobLocation
} from "@/lib/interviews/audio-storage";

test("Vercel server upload defaults stay below the function body limit", () => {
  assert.equal(serverAudioMaxBytes({}), 4 * 1024 * 1024);
  assert.equal(serverAudioMaxBytes({ MAX_AUDIO_UPLOAD_MB: "invalid" }), 4 * 1024 * 1024);
  assert.equal(directAudioMaxBytes({}), 25 * 1024 * 1024);
});

test("direct audio uploads require a configured private Blob token", () => {
  assert.equal(directAudioUploadsEnabled({}), false);
  assert.equal(directAudioUploadsEnabled({ BLOB_READ_WRITE_TOKEN: "blob-token" }), true);
});

test("interview blob paths are scoped to one private interview folder", () => {
  const interviewId = "interview-123";
  const pathname = `${interviewAudioPathPrefix(interviewId)}recording-suffix.mp3`;

  assert.doesNotThrow(() =>
    validateInterviewBlobLocation({
      interviewId,
      pathname,
      url: `https://store.private.blob.vercel-storage.com/${pathname}`
    })
  );
  assert.throws(
    () =>
      validateInterviewBlobLocation({
        interviewId,
        pathname,
        url: `https://store.public.blob.vercel-storage.com/${pathname}`
      }),
    PublicApiError
  );
  assert.throws(
    () =>
      validateInterviewBlobLocation({
        interviewId,
        pathname: "interviews/another-interview/recording.mp3",
        url: "https://store.private.blob.vercel-storage.com/interviews/another-interview/recording.mp3"
      }),
    PublicApiError
  );
});

test("interview audio validates type and direct-upload size", () => {
  assert.doesNotThrow(() =>
    validateInterviewAudioUpload({
      filename: "recording.mp3",
      contentType: "audio/mpeg",
      size: 10 * 1024 * 1024,
      maxBytes: 25 * 1024 * 1024
    })
  );
  assert.throws(
    () =>
      validateInterviewAudioUpload({
        filename: "notes.exe",
        contentType: "application/octet-stream",
        size: 1024,
        maxBytes: 25 * 1024 * 1024
      }),
    PublicApiError
  );
  assert.throws(
    () =>
      validateInterviewAudioUpload({
        filename: "disguised.exe",
        contentType: "audio/mpeg",
        size: 1024,
        maxBytes: 25 * 1024 * 1024
      }),
    PublicApiError
  );
  assert.throws(
    () =>
      validateInterviewAudioUpload({
        filename: "empty.mp3",
        contentType: "audio/mpeg",
        size: 0,
        maxBytes: 25 * 1024 * 1024
      }),
    PublicApiError
  );
  assert.throws(
    () =>
      validateInterviewAudioUpload({
        filename: "recording.wav",
        contentType: "audio/wav",
        size: 26 * 1024 * 1024,
        maxBytes: 25 * 1024 * 1024
      }),
    PublicApiError
  );
});
