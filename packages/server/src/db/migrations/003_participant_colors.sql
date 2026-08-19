-- Give every participant a stable colour.
--
-- Colouring by *kind* - all humans one colour, all agents another - stops
-- working the moment a session has more than one of each: the transcript turns
-- into a wall of identical blue names. A colour per account, fixed for its
-- lifetime, is what lets a reader recognise who is speaking at a glance.
--
-- Values are CSS colour keywords, so a client that renders them directly still
-- gets a sensible result.

ALTER TABLE agents ADD COLUMN avatar_color TEXT NOT NULL DEFAULT 'blue';

-- Existing rows carried hex values chosen per registration. Map every account
-- onto the palette deterministically from its id, so the assignment is stable
-- and evenly spread rather than everyone landing on the default.
UPDATE users
SET avatar_color = (ARRAY['red','blue','green','skyblue','violet','pink','orange','yellow','cyan'])[
  1 + (get_byte(decode(md5(id), 'hex'), 0) % 9)
];

UPDATE agents
SET avatar_color = (ARRAY['red','blue','green','skyblue','violet','pink','orange','yellow','cyan'])[
  1 + (get_byte(decode(md5(id), 'hex'), 1) % 9)
];

ALTER TABLE users ALTER COLUMN avatar_color SET DEFAULT 'blue';
