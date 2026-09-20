-- Optional, separately applied after the regular Drizzle migrations.
-- Absence of pgvector is supported: the default tenant-scoped GIN full-text
-- index remains active. Enable KNOWLEDGE_VECTOR_ENABLED only after this step.
-- These optional objects are intentionally outside the base Drizzle schema.
-- Never use drizzle-kit push: it can drop embedding/indexes and raw SQL guards.
-- The repository config blocks push; apply reviewed additive migrations instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE public.knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);
    CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding ON public.knowledge_chunks USING hnsw (embedding vector_cosine_ops);
  ELSE
    RAISE NOTICE 'pgvector is unavailable; using tenant-scoped full-text knowledge retrieval';
  END IF;
END $$;
