
alter type public.user_role add value if not exists 'owner';
alter type public.user_role add value if not exists 'manager';
alter type public.user_role add value if not exists 'support';
alter type public.user_role add value if not exists 'dispatcher';
