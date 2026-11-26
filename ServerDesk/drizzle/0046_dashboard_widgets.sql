-- Dashboard widgets (docs/dashboard.md, "Storage"): a stored layout was a JSON array with one {id, shown} entry per tile
-- of the first Dashboard; it is now {"version":2,"widgets":[{id, w, h}, ...]}, the widgets on the board with their
-- sizes. This rewrites every stored array exactly as storedDashboardLayout in lib/dashboard-layout.ts reads it: the
-- shown tiles in their stored order, a tile that the array does not name appended, each with its default size. A
-- layout of the new form, unreadable text and anything else stay as they are (the CASE reads the text as JSON only
-- after pg_input_is_valid). No schema change.
UPDATE account_preferences AS p SET dashboard_layout=(
 SELECT json_build_object('version',2,'widgets',COALESCE(json_agg(json_build_object('id',d.id,'w',d.w,'h',d.h) ORDER BY COALESCE(f.pos,1000+d.ord)),'[]'::json))::text
 FROM (VALUES ('alarms',2,2,1),('offline',1,2,2),('updates',1,2,3),('jobs',2,2,4),('alarm-week',2,2,5)) AS d(id,w,h,ord)
 LEFT JOIN LATERAL (
  SELECT e.pos,e.item FROM jsonb_array_elements(p.dashboard_layout::jsonb) WITH ORDINALITY AS e(item,pos)
  WHERE CASE WHEN jsonb_typeof(e.item)='object' THEN e.item->>'id'=d.id ELSE false END ORDER BY e.pos LIMIT 1
 ) AS f ON true
 WHERE f.pos IS NULL OR f.item->'shown' IS DISTINCT FROM 'false'::jsonb
)
WHERE CASE WHEN p.dashboard_layout IS NOT NULL AND pg_input_is_valid(p.dashboard_layout,'jsonb') THEN jsonb_typeof(p.dashboard_layout::jsonb)='array' ELSE false END;--> statement-breakpoint
UPDATE dashboard_settings AS p SET default_layout=(
 SELECT json_build_object('version',2,'widgets',COALESCE(json_agg(json_build_object('id',d.id,'w',d.w,'h',d.h) ORDER BY COALESCE(f.pos,1000+d.ord)),'[]'::json))::text
 FROM (VALUES ('alarms',2,2,1),('offline',1,2,2),('updates',1,2,3),('jobs',2,2,4),('alarm-week',2,2,5)) AS d(id,w,h,ord)
 LEFT JOIN LATERAL (
  SELECT e.pos,e.item FROM jsonb_array_elements(p.default_layout::jsonb) WITH ORDINALITY AS e(item,pos)
  WHERE CASE WHEN jsonb_typeof(e.item)='object' THEN e.item->>'id'=d.id ELSE false END ORDER BY e.pos LIMIT 1
 ) AS f ON true
 WHERE f.pos IS NULL OR f.item->'shown' IS DISTINCT FROM 'false'::jsonb
)
WHERE CASE WHEN pg_input_is_valid(p.default_layout,'jsonb') THEN jsonb_typeof(p.default_layout::jsonb)='array' ELSE false END;
