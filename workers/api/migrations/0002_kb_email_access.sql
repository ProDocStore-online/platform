-- KB-level access allowlists for platform-native private publishing.
-- Members still control edit/review/admin rights. These fields grant viewer
-- access after ProDocStore sign-in when the user's verified email matches.

ALTER TABLE knowledge_bases ADD COLUMN access_email_domains TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_bases ADD COLUMN access_allowed_emails TEXT NOT NULL DEFAULT '';
