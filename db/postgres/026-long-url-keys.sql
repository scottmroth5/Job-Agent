-- Url keys over 500 characters become their first 400 characters, #sha256=, and the SHA-256 of the whole key (UTF-8,
-- hex), as tools/urls.ts capUrlKey and the SQLite migration of the same name do. left() and char_length() count
-- characters, as SQLite's length() and JavaScript's Array.from do. A key over about 2.7 KB could never be stored here,
-- but keys between 500 characters and that size could.
UPDATE postings
SET url_key = left(url_key, 400) || '#sha256=' || encode(sha256(convert_to(url_key, 'UTF8')), 'hex')
WHERE char_length(url_key) > 500;
