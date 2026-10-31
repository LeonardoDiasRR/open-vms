-- OpenVMS schema consolidado (consolidacao das migracoes 001-009, 2026-10-27; corregido 2026-10-27: media_hours.session presente).
-- NAO editar: mudancas futuras de schema entram como 002_...sql em diante.
-- Aplicado pelo runner (pgpool.migrate) como UMA transacao implicita: crash = nada aplicado.
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 17.8 (Debian 17.8-0+deb13u1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: bump_catalog_rev(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION bump_catalog_rev() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM nextval('catalog_rev_seq');
  RETURN NULL;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE access_profiles (
    id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: camera_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE camera_addresses (
    camera_id uuid NOT NULL,
    ord integer NOT NULL,
    address text NOT NULL
);


--
-- Name: camera_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE camera_grants (
    profile_id text NOT NULL,
    camera_id uuid NOT NULL,
    level text NOT NULL,
    CONSTRAINT camera_grants_level_check CHECK ((level = ANY (ARRAY['view'::text, 'control'::text])))
);


--
-- Name: cameras; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE cameras (
    id uuid NOT NULL,
    name text NOT NULL,
    state text DEFAULT 'provisioning'::text NOT NULL,
    added_via text,
    recording boolean DEFAULT false NOT NULL,
    error_code text,
    credential_ref text,
    device_id uuid,
    group_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE candidates (
    id uuid NOT NULL,
    scan_id uuid,
    ip inet,
    xaddr text,
    name text,
    manufacturer text,
    model text,
    status text,
    outcome text,
    seen_count integer DEFAULT 1 NOT NULL,
    video_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    open_ports integer[] DEFAULT '{}'::integer[] NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: catalog_rev_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE catalog_rev_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE credentials (
    ref text NOT NULL,
    username text,
    secret text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE devices (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE events (
    id uuid NOT NULL,
    ts bigint NOT NULL,
    kind text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    message text NOT NULL,
    camera_id uuid,
    profile_id uuid
);


--
-- Name: exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE exports (
    id uuid NOT NULL,
    stream_profile_id uuid,
    camera_name text,
    state text NOT NULL,
    progresso integer DEFAULT 0 NOT NULL,
    path text,
    bytes bigint,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    from_ts bigint,
    to_ts bigint,
    description text,
    CONSTRAINT exports_description_len CHECK (((description IS NULL) OR ((char_length(description) >= 1) AND (char_length(description) <= 50))))
);


--
-- Name: gaps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE gaps (
    id uuid NOT NULL,
    stream_profile_id uuid NOT NULL,
    from_ts bigint NOT NULL,
    to_ts bigint NOT NULL,
    reason text
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE groups (
    id uuid NOT NULL,
    name text NOT NULL,
    parent_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE layouts (
    id uuid NOT NULL,
    name text NOT NULL,
    cells jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_ts timestamp with time zone DEFAULT now() NOT NULL,
    updated_ts timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_days; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE media_days (
    profile_id text NOT NULL,
    day date NOT NULL,
    dir_mtime_ns bigint NOT NULL,
    hour_files integer DEFAULT 0 NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_hours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE media_hours (
    profile_id text NOT NULL,
    day date NOT NULL,
    hour smallint NOT NULL,
    path text NOT NULL,
    size_bytes bigint NOT NULL,
    mtime_ns bigint NOT NULL,
    timescale integer,
    nominal_ms integer,
    init_fim bigint,
    anchor bigint,
    end_ts bigint,
    frags jsonb DEFAULT '[]'::jsonb NOT NULL,
    error text,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    coverage jsonb DEFAULT '[]'::jsonb NOT NULL,
    frag_count integer DEFAULT 0 NOT NULL,
    session smallint DEFAULT 0 NOT NULL,
    CONSTRAINT media_hours_hour_check CHECK (((hour >= 0) AND (hour <= 23)))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE profiles (
    id uuid NOT NULL,
    camera_id uuid NOT NULL,
    name text NOT NULL,
    source_url text,
    recording_mode text,
    width integer,
    height integer,
    onvif_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE scans (
    id uuid NOT NULL,
    kind text,
    state text NOT NULL,
    scope jsonb,
    found integer DEFAULT 0 NOT NULL,
    error text,
    started_ts timestamp with time zone DEFAULT now() NOT NULL,
    finished_ts timestamp with time zone
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE sessions (
    token_hash text NOT NULL,
    username text NOT NULL,
    credential_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE users (
    username text NOT NULL,
    profile_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    secret_hash text NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    credential_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: access_profiles access_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY access_profiles
    ADD CONSTRAINT access_profiles_pkey PRIMARY KEY (id);


--
-- Name: camera_addresses camera_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY camera_addresses
    ADD CONSTRAINT camera_addresses_pkey PRIMARY KEY (camera_id, ord);


--
-- Name: camera_grants camera_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY camera_grants
    ADD CONSTRAINT camera_grants_pkey PRIMARY KEY (profile_id, camera_id);


--
-- Name: cameras cameras_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY cameras
    ADD CONSTRAINT cameras_pkey PRIMARY KEY (id);


--
-- Name: candidates candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY candidates
    ADD CONSTRAINT candidates_pkey PRIMARY KEY (id);


--
-- Name: credentials credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (ref);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: exports exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY exports
    ADD CONSTRAINT exports_pkey PRIMARY KEY (id);


--
-- Name: gaps gaps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY gaps
    ADD CONSTRAINT gaps_pkey PRIMARY KEY (id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: layouts layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY layouts
    ADD CONSTRAINT layouts_pkey PRIMARY KEY (id);


--
-- Name: media_days media_days_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY media_days
    ADD CONSTRAINT media_days_pkey PRIMARY KEY (profile_id, day);


--
-- Name: media_hours media_hours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY media_hours
    ADD CONSTRAINT media_hours_pkey PRIMARY KEY (profile_id, day, hour, session);


--
-- Name: profiles profiles_camera_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY profiles
    ADD CONSTRAINT profiles_camera_id_name_key UNIQUE (camera_id, name);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: scans scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY scans
    ADD CONSTRAINT scans_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (username);


--
-- Name: access_profiles_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX access_profiles_kind_idx ON access_profiles USING btree (kind);


--
-- Name: access_profiles_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX access_profiles_name_idx ON access_profiles USING btree (lower(name));


--
-- Name: access_profiles_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX access_profiles_name_trgm_idx ON access_profiles USING gin (name gin_trgm_ops);


--
-- Name: camera_grants_camera_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX camera_grants_camera_idx ON camera_grants USING btree (camera_id);


--
-- Name: cameras_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cameras_device_idx ON cameras USING btree (device_id);


--
-- Name: cameras_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cameras_group_idx ON cameras USING btree (group_id);


--
-- Name: cameras_offline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cameras_offline_idx ON cameras USING btree (state) WHERE (state <> 'online'::text);


--
-- Name: cameras_recording_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cameras_recording_idx ON cameras USING btree (recording) WHERE recording;


--
-- Name: cameras_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cameras_updated_idx ON cameras USING btree (updated_at, id);


--
-- Name: candidates_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX candidates_last_seen_idx ON candidates USING btree (last_seen_at);


--
-- Name: candidates_scan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX candidates_scan_idx ON candidates USING btree (scan_id);


--
-- Name: candidates_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX candidates_status_idx ON candidates USING btree (status);


--
-- Name: events_camera_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_camera_idx ON events USING btree (camera_id, ts DESC);


--
-- Name: events_cursor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_cursor_idx ON events USING btree (ts DESC, id DESC);


--
-- Name: events_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_kind_idx ON events USING btree (kind, ts DESC);


--
-- Name: exports_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exports_active_idx ON exports USING btree (state) WHERE (state = ANY (ARRAY['queued'::text, 'exporting'::text]));


--
-- Name: gaps_overlap_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gaps_overlap_idx ON gaps USING btree (stream_profile_id, from_ts, to_ts);


--
-- Name: groups_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX groups_parent_idx ON groups USING btree (parent_id);


--
-- Name: media_hours_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_hours_day_idx ON media_hours USING btree (day);


--
-- Name: profiles_camera_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_camera_idx ON profiles USING btree (camera_id);


--
-- Name: profiles_continuous_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_continuous_idx ON profiles USING btree (camera_id) WHERE (recording_mode = 'continuous'::text);


--
-- Name: scans_running_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scans_running_idx ON scans USING btree (state) WHERE (state = 'running'::text);


--
-- Name: scans_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scans_started_idx ON scans USING btree (started_ts DESC);


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_idx ON sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON sessions USING btree (username);


--
-- Name: users_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_name_trgm_idx ON users USING gin (username gin_trgm_ops);


--
-- Name: users_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_profile_idx ON users USING btree (profile_id);


--
-- Name: users_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_status_idx ON users USING btree (status);


--
-- Name: cameras cameras_rev; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cameras_rev AFTER INSERT OR DELETE OR UPDATE ON cameras FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_rev();


--
-- Name: devices devices_rev; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER devices_rev AFTER INSERT OR DELETE OR UPDATE ON devices FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_rev();


--
-- Name: camera_grants grants_rev; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grants_rev AFTER INSERT OR DELETE OR UPDATE ON camera_grants FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_rev();


--
-- Name: groups groups_rev; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER groups_rev AFTER INSERT OR DELETE OR UPDATE ON groups FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_rev();


--
-- Name: profiles profiles_rev; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_rev AFTER INSERT OR DELETE OR UPDATE ON profiles FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_rev();


--
-- Name: camera_addresses camera_addresses_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY camera_addresses
    ADD CONSTRAINT camera_addresses_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE;


--
-- Name: camera_grants camera_grants_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY camera_grants
    ADD CONSTRAINT camera_grants_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE;


--
-- Name: camera_grants camera_grants_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY camera_grants
    ADD CONSTRAINT camera_grants_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES access_profiles(id) ON DELETE CASCADE;


--
-- Name: cameras cameras_credential_ref_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY cameras
    ADD CONSTRAINT cameras_credential_ref_fkey FOREIGN KEY (credential_ref) REFERENCES credentials(ref) ON DELETE SET NULL;


--
-- Name: cameras cameras_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY cameras
    ADD CONSTRAINT cameras_device_id_fkey FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;


--
-- Name: cameras cameras_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY cameras
    ADD CONSTRAINT cameras_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL;


--
-- Name: candidates candidates_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY candidates
    ADD CONSTRAINT candidates_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE;


--
-- Name: events events_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY events
    ADD CONSTRAINT events_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE SET NULL;


--
-- Name: events events_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY events
    ADD CONSTRAINT events_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;


--
-- Name: exports exports_stream_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY exports
    ADD CONSTRAINT exports_stream_profile_id_fkey FOREIGN KEY (stream_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;


--
-- Name: gaps gaps_stream_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY gaps
    ADD CONSTRAINT gaps_stream_profile_id_fkey FOREIGN KEY (stream_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;


--
-- Name: groups groups_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY groups
    ADD CONSTRAINT groups_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE SET NULL;


--
-- Name: profiles profiles_camera_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY profiles
    ADD CONSTRAINT profiles_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_username_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_username_fkey FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE;


--
-- Name: users users_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES access_profiles(id);


--
-- PostgreSQL database dump complete
--


