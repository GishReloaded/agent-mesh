-- Let people upload a picture, and change the colour they were given.
--
-- The image itself lives in object storage - a bucket on the serverless
-- deployment, a directory on a self-hosted one - because a database is a poor
-- place to keep bytes that are only ever streamed back unchanged. The row
-- holds the key, which changes on every upload so no cache has to be told
-- that the old picture is gone.

ALTER TABLE users ADD COLUMN avatar_key TEXT;
