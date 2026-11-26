-- Data only. The built-in roles are seeded with ON CONFLICT DO NOTHING
-- (lib/rbac.ts), so existing rows never get rights that a release adds. Add the
-- Microsoft Defender rights of docs/local-identity-rbac.md to the stored lists:
-- Reader gets defender.read, Operator and Device Administrator get
-- defender.read and defender.control. Only the built-in rows change; custom
-- and customer roles stay. A right that a row already holds is not added again,
-- so a second run changes nothing. The list keeps the JSON form of JSON.stringify.
UPDATE rbac_roles SET permissions='['||(
  SELECT string_agg(to_json(right_id)::text,',' ORDER BY position)
  FROM (
    SELECT value AS right_id,ordinality AS position FROM jsonb_array_elements_text(rbac_roles.permissions::jsonb) WITH ORDINALITY
    UNION ALL
    SELECT added.right_id,1000+added.position FROM (VALUES ('defender.read',1),('defender.control',2)) AS added(right_id,position)
    WHERE (added.right_id='defender.read' OR rbac_roles.id<>'builtin-reader')
      AND NOT (rbac_roles.permissions::jsonb ? added.right_id)
  ) AS rights
)||']'
 WHERE builtin=1
   AND id IN ('builtin-reader','builtin-operator','builtin-device-administrator')
   AND permissions IS JSON ARRAY
   AND NOT (permissions::jsonb ? '*')
   AND (NOT (permissions::jsonb ? 'defender.read') OR (id<>'builtin-reader' AND NOT (permissions::jsonb ? 'defender.control')));
