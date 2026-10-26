-- The database plugin's own schema: revbound.meta holds the production stamp and the local database id, nothing else.
create schema if not exists revbound;
create table if not exists revbound.meta (key text primary key not null, value text not null);
