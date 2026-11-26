-- Data only. The seed in 0000_baseline.sql stamps the first customer's
-- created_at and updated_at with two separate clock reads, so the two values
-- can differ by a millisecond. Give the seed row one timestamp. A gap of more
-- than one second is a real later edit and stays; other customers stay.
UPDATE customers SET updated_at=created_at
 WHERE id='00000000-0000-4000-8000-000000000100'
   AND updated_at-created_at BETWEEN 1 AND 1000;
