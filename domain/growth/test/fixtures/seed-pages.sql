CREATE TABLE IF NOT EXISTS pages (
  page_id   TEXT PRIMARY KEY,
  page_name TEXT NOT NULL,
  scraped_at TEXT NOT NULL
);

INSERT INTO pages VALUES ('page_001', 'Acme Corp',            '2026-03-30T10:00:00Z');
INSERT INTO pages VALUES ('page_002', 'Beta Industries',      '2026-03-30T10:00:00Z');
INSERT INTO pages VALUES ('page_003', 'Delta Systems',        '2026-03-30T10:05:00Z');
INSERT INTO pages VALUES ('page_004', 'Orbit Retail',         '2026-03-30T10:05:00Z');
INSERT INTO pages VALUES ('page_005', 'Nexus Software',       '2026-03-30T10:10:00Z');
INSERT INTO pages VALUES ('page_006', 'Vantage Health',       '2026-03-30T10:10:00Z');
INSERT INTO pages VALUES ('page_007', 'Crestline Finance',    '2026-03-30T10:15:00Z');
INSERT INTO pages VALUES ('page_008', 'Polar Outdoors',       '2026-03-30T10:15:00Z');
INSERT INTO pages VALUES ('page_009', 'Meridian Education',   '2026-03-30T10:20:00Z');
INSERT INTO pages VALUES ('page_010', 'Solaris Energy',       '2026-03-30T10:20:00Z');
