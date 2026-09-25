-- Apply this statement separately before the access script; PostgreSQL enum values
-- become usable after the transaction containing ALTER TYPE commits.
alter type public.user_role add value if not exists 'accountant';
