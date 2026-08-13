-- Prevent completion callbacks and browser confirmations from creating duplicate records.
CREATE UNIQUE INDEX "InterviewRecording_filePath_key" ON "InterviewRecording"("filePath");
