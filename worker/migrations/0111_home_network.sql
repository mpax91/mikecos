-- Home → Internet (2026-10-12). Mike types in every internet-connected
-- device in the house as Google Home lists them under Devices. Routes in
-- worker/src/home.ts (/api/home/network/*), UI src/components/HomeInternetPage.tsx.

-- Wi-Fi points (the router + mesh points: "Basement", "Study Puck"…), a
-- managed list so devices can be grouped/filtered by the point they hang off.
CREATE TABLE home_network_points (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE home_network_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  device_type TEXT,            -- "Google Home Mini", "Chromecast"… free text
  manufacturer TEXT,
  model TEXT,
  connection TEXT CHECK (connection IS NULL OR connection IN ('wired', '2.4ghz', '5ghz', '6ghz')),
  point_id TEXT,               -- home_network_points.id (nulled when the point is deleted)
  room_id TEXT,                -- home_rooms.id, optional (nulled when the room/floor is deleted)
  mac_address TEXT,            -- normalized AA:BB:CC:DD:EE:FF when it's 12 hex digits
  ip_address TEXT,
  ip_reserved INTEGER NOT NULL DEFAULT 0,  -- reserved / static on the router
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_home_network_devices_point ON home_network_devices(point_id);
CREATE INDEX idx_home_network_devices_room ON home_network_devices(room_id);
