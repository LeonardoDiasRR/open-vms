'use strict';

// ---- STABLE error registry (task 4.1). Before, every handler threw the HTTP status inside the
// message itself (`throw new Error('404: camera not found')`) and the main.js dispatcher parsed the
// prefix. Here the status and the text become DATA: the snake_case code is the public contract, the
// message is what the client displays. `{name}` is replaced by the AppError `params`.
// ---- Never translate the CODE: it is the stable key the client (and the tests) use.

const ERRORS = {
  // -- transport, session and password
  not_authenticated: { status: 401, message: 'Not authenticated' },
  invalid_credentials: { status: 401, message: 'Invalid credentials' },
  invalid_session: { status: 401, message: 'Invalid session' },
  https_required: { status: 403, message: 'HTTPS is required outside loopback' },
  origin_not_allowed: { status: 403, message: 'Origin is not allowed' },
  password_change_required: { status: 403, message: 'Password change is required' },
  current_password_invalid: { status: 403, message: 'Current password is invalid' },
  password_too_short: { status: 400, message: 'Password must be at least {min} characters long' },
  route_not_found: { status: 404, message: 'Route not found' },
  bad_request: { status: 400, message: '{message}' },
  media_temporarily_unavailable: { status: 503, message: 'Media temporarily unavailable; retry' },

  // -- authorization (rbac.js / access.js)
  unknown_capability: { status: 403, message: 'Unknown capability {action}' },
  profile_capability_denied: { status: 403, message: 'Profile {profile} cannot perform {action}' },
  access_policy_missing: { status: 500, message: 'Route has no access policy: {route}' },
  boot_policy_missing: { status: 500, message: 'Boot refused: routes without access policy: {routes}' },

  // -- cameras and devices (api/devices.js, api/onvif.js, lib/onvif.js, lib/cameras.js)
  camera_not_found: { status: 404, message: 'Camera not found' },
  camera_inactive: { status: 409, message: 'Camera is inactive' },
  device_not_found: { status: 404, message: 'Device not found' },
  camera_address_required: { status: 400, message: 'Camera has no address' },
  device_address_required: { status: 400, message: 'Device has no address' },
  camera_onvif_address_required: { status: 400, message: 'Camera has no ONVIF address' },
  device_onvif_address_required: { status: 400, message: 'Device has no ONVIF address' },
  camera_credentials_required: { status: 400, message: 'Camera has no credentials' },
  device_credentials_required: { status: 400, message: 'Device has no credentials' },
  classify_credentials_required: { status: 400, message: 'Credentials are required for classification' },
  manufacturer_unknown: { status: 400, message: 'Unknown manufacturer' },
  onvif_unreachable: { status: 502, message: 'ONVIF unreachable: {reason}' },
  onvif_action_unsupported: { status: 400, message: 'Unsupported ONVIF action: {action}' },
  onvif_profile_token_required: { status: 400, message: 'profileToken is required for GetStreamUri' },
  onvif_call_failed: { status: 502, message: 'ONVIF {action} failed: {reason}' },
  onvif_http_failed: { status: 502, message: 'ONVIF {action} returned HTTP {status}' },
  camera_transition_invalid: { status: 500, message: 'Invalid camera transition {from} -> {to}' },
  scan_not_found: { status: 404, message: 'Scan not found' },
  scan_credentials_rejected: { status: 429, message: 'Credentials rejected {count} times, scan stopped (the recorder locks after about 30 failures)' },

  // -- discovery
  ip_required: { status: 400, message: 'IP address is required' },
  invalid_range: { status: 400, message: 'Invalid range or IP: {value}' },
  range_too_large: { status: 400, message: 'Range is too large (max 1024 IPs)' },
  cidr_too_large: { status: 500, message: 'CIDR is too large (max /22)' },

  // -- video profiles (api/devices.js, api/live.js, lib/transcoder.js)
  stream_profile_not_found: { status: 404, message: 'Stream profile not found' },
  stream_profile_name_required: { status: 400, message: 'Stream profile name is required' },
  stream_profile_source_required: { status: 400, message: 'Stream profile source is required' },
  stream_profile_name_taken: { status: 400, message: 'A stream profile with that name already exists' },
  stream_profile_invalid: { status: 400, message: 'Invalid profile' },
  source_required: { status: 400, message: 'Source is required' },
  name_required: { status: 400, message: 'Name is required' },
  last_profile: { status: 400, message: 'Cannot delete the last profile' },
  profile_role_unpublished: { status: 404, message: 'Profile has no published role on the Hub' },

  // -- access profiles (lib/access.js, api/access.js, api/users.js)
  access_profile_not_found: { status: 404, message: 'Access profile not found' },
  access_profile_name_required: { status: 400, message: 'Access profile name is required' },
  access_profile_name_reserved: { status: 400, message: 'Reserved name: {name}' },
  access_profile_exists: { status: 409, message: 'Access profile {name} already exists' },
  access_profile_system_immutable: { status: 409, message: 'System profile is not editable: {id}' },
  access_profile_in_use: { status: 409, message: 'Access profile in use by {profiles}' },
  access_profile_invalid: { status: 400, message: 'Access profile {id} does not exist' },
  access_profile_required: { status: 400, message: 'Access profile is required' },
  camera_required: { status: 400, message: 'Camera is required' },
  level_invalid: { status: 400, message: 'level must be one of {levels}' },

  // -- users (api/users.js)
  user_not_found: { status: 404, message: 'User not found' },
  user_exists: { status: 400, message: 'User {username} already exists' },
  username_required: { status: 400, message: 'Username is required' },
  admin_immutable: { status: 400, message: 'The admin user is immutable' },
  user_status_invalid: { status: 400, message: 'Status must be active or disabled' },
  last_admin_required: { status: 400, message: 'At least one active admin is required' },
  new_username_required: { status: 400, message: 'New username is required' },
  username_unchanged: { status: 400, message: 'New name is the same as the current one' },

  // -- groups and layouts (api/groups.js, api/layouts.js)
  group_not_found: { status: 404, message: 'Group not found' },
  parent_group_not_found: { status: 404, message: 'Parent group not found' },
  group_cycle: { status: 400, message: 'A group cannot be moved inside itself' },
  group_name_required: { status: 400, message: 'Group name is required' },
  layout_not_found: { status: 404, message: 'Layout not found' },
  layout_exists: { status: 409, message: 'A layout named "{name}" already exists' },
  layout_cells_invalid: { status: 400, message: 'Invalid cells' },
  layout_cell_without_id: { status: 400, message: 'Cell has no id' },
  layout_cell_geometry_invalid: { status: 400, message: 'Invalid cell geometry (col/row >= 0, colspan/rowspan >= 1)' },
  layout_ids_required: { status: 400, message: 'Layout ids are required' },

  // -- archive, recording, export and transcode (api/archive.js, api/files.js, lib/main.js)
  period_invalid: { status: 400, message: 'Invalid period' },
  period_too_long: { status: 400, message: 'Period is too long (max {buckets} buckets)' },
  export_period_too_long: { status: 400, message: 'Maximum period is 30 minutes' },
  media_index_missing: { status: 500, message: 'Media index is not configured' },
  archive_root_missing: { status: 500, message: 'archiveRoot is not configured' },
  export_not_found: { status: 404, message: 'Export not found' },
  export_without_camera: { status: 404, message: 'Export has no camera' },
  export_file_missing: { status: 404, message: 'Export file is gone from disk' },
  export_disk_full: { status: 507, message: 'Not enough disk space to export' },
  // spec 2026-10-23 (batch deletion): refuses BEFORE deleting anything.
  export_active: { status: 409, message: 'One of the exports is still being generated' },
  export_not_ready: { status: 409, message: 'One of the exports is not finished' },
  recording_in_period_missing: { status: 404, message: 'No recording in the period' },
  recording_limit_reached: { status: 409, message: 'Recordings reached the disk usage limit' },
  segment_not_found: { status: 404, message: 'Segment not found' },
  segments_missing: { status: 500, message: 'No segment in the period' },
  fragment_window_empty: { status: 404, message: 'No fragment in the window' },
  recording_at_instant_missing: { status: 404, message: 'No recording at that instant' },
  hour_file_missing: { status: 404, message: 'Hour file not found' },
  chunk_evicted: { status: 404, message: 'Chunk is gone, request it again' },
  chunk_not_scheduled: { status: 404, message: 'Chunk {ini} is not scheduled for {profile}' },
  transcode_chunk_timeout: { status: 503, message: 'Chunk {ini} of {profile} did not arrive within {ms} ms' },
  window_without_chunks: { status: 404, message: 'Window has no chunks: {from}..{to}' },
  hour_source_missing: { status: 404, message: 'No source for {file}' },
  transcode_ceiling_reached: { status: 429, message: 'Transcode session ceiling of {max} reached' },
  transcode_fragments_missing: { status: 502, message: 'Chunk {ini} produced no parsed fragments' },
  codec_unsupported: { status: 415, message: 'incompatibleCodec: transcode serves only h264, requested={codec}' },
  probe_json_invalid: { status: 502, message: 'ffprobe returned no JSON: {path}' },
  source_missing: { status: 404, message: 'Source does not exist: {path}' },
  ini_invalid: { status: 400, message: 'Invalid ini' },
  recording_hour_exists: { status: 500, message: 'No segment recorded: the hour file already exists' },
  recording_hour_busy: { status: 500, message: 'No segment recorded: the hour file is still being written' },
  recording_hour_full: { status: 500, message: 'No segment recorded: the hour reached its session ceiling' },
  recording_empty: { status: 500, message: 'No segment recorded: {reason}' },
  recording_interrupted: { status: 500, message: 'Recording interrupted: {reason}' },

  // -- settings (api/settings.js, api/devices.js)
  archive_dir_immutable: { status: 400, message: 'archive_dir is no longer configurable through the API' },
  retention_days_invalid: { status: 400, message: 'retention_days must be an integer >= 1' },
  disk_max_percent_invalid: { status: 400, message: 'disk_max_percent must be an integer between 1 and 100' },
  retention_days_removed: { status: 400, message: 'retention_days is no longer accepted: retention is global' },
  field_invalid: { status: 400, message: '{field} is invalid' },
  fov_order_invalid: { status: 400, message: 'fov_min_deg must be less than fov_max_deg' },
  recording_flag_invalid: { status: 400, message: 'recording must be a boolean' },

  // -- PTZ (api/ptz.js, lib/ptz-viewport.js)
  position_not_found: { status: 404, message: 'Position not found' },
  ptz_absolute_unavailable: { status: 409, message: 'Absolute positioning is unavailable' },
  velocity_zero: { status: 400, message: 'Velocity is zero' },
  ptz_profile_missing: { status: 502, message: 'Camera has no ONVIF profile for PTZ' },
  ptz_position_missing: { status: 502, message: 'Camera did not report its position' },
  position_without_absolute_axis: { status: 400, message: 'Position has no absolute axis' },
  ptz_positions_limit_reached: { status: 400, message: 'Limit of 20 saved positions reached' },
  camera_no_absolute_position: { status: 400, message: 'Camera has no absolute position' },
  ptz_space_unsupported: { status: 409, message: 'PTZ space is not supported' },
  box_invalid: { status: 400, message: 'Invalid box' },
  box_outside_video: { status: 400, message: 'Box is outside the video' },
  box_empty: { status: 400, message: 'Box is empty' },
  area_zoom_missing: { status: 409, message: 'No area zoom in this session' },

  // -- Hub and dependencies (lib/hub-config.js, api/restream.js, lib/pg.js)
  hub_path_refused: { status: 502, message: 'Hub refused the path {path}: {body}' },
  hub_remove_refused: { status: 502, message: 'Hub refused to remove {path}: {body}' },
  hub_paths_unlisted: { status: 502, message: 'Hub did not list the paths' },
  hub_session_expel_refused: { status: 502, message: 'Hub refused to expel session {id}' },
  hub_status_error: { status: 502, message: 'Hub returned {status}: {reason}' },
  pg_missing: { status: 500, message: 'Install pg: cd server && npm install pg' },
};

// `{name}` -> params.name. A missing key stays visible (`{name}`) instead of becoming "undefined": it
// is a programming error, and the literal denounces it in the client log.
const interpolate = (message, params) =>
  message.replace(/\{(\w+)\}/g, (whole, key) => (params && key in params ? String(params[key]) : whole));

class AppError extends Error {
  constructor(code, params = {}) {
    const entry = ERRORS[code];
    super(entry ? interpolate(entry.message, params) : code);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
    this.status = entry ? entry.status : 500;
  }
}

module.exports = { AppError, ERRORS };

