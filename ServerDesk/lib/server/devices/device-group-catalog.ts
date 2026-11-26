
import {allowedGroupIds,customerAccessGuard,globalPermissionGuard,groupPermissions,hasGlobalPermission,principal} from '../identity/access';
import type {DeviceGroup,DevicePermissionTarget,Viewer} from '../../types';
import {db,sql} from '../db';
import {deviceGroupHasAssignmentsSql,deviceGroupHasMembersSql} from './device-groups';
import {deviceGroupDeleteNeedsStepUp} from '../../step-up';

// Group scopes remain discoverable before their first device is enrolled. A
// device-only assignment adds its group path for orientation, without exposing
// unrelated empty siblings or granting access to the path's other devices.
// Every branch stays within the customers the viewer sees (customer boundary).
export async function deviceGroupCatalog(viewer:Viewer,visibleDeviceIds:string[]):Promise<DeviceGroup[]>{
 const [viewGroups,managedGroups]=await Promise.all([allowedGroupIds(viewer,'view'),allowedGroupIds(viewer,'groups.manage')]);
 const scopes=JSON.stringify([...new Set([...viewGroups,...managedGroups])]),devices=JSON.stringify(visibleDeviceIds);
 const me=sql`${principal(viewer)}`,assignmentTargets=globalPermissionGuard(me,'portal.roleAssignments.manage'),boundary=customerAccessGuard(sql`g.customer_id`,me);
 const rows=await db().query<Omit<DeviceGroup,'permissions'|'stepUpOnDelete'>&{hasMembers:boolean;hasAssignments:boolean}>(sql`SELECT g.id,g.name,g.description,g.parent_id AS "parentId",g.customer_id AS "customerId",
 ${deviceGroupHasMembersSql(sql`g.id`)} AS "hasMembers",${deviceGroupHasAssignmentsSql(sql`g.id`)} AS "hasAssignments",
 (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id) AS depth,
 (SELECT count(DISTINCT m.server_id) FROM device_group_ancestors a JOIN device_group_members m ON m.group_id=a.group_id JOIN servers s ON s.id=m.server_id
  WHERE a.ancestor_id=g.id AND s.revoked=0 AND s.id IN (SELECT value FROM jsonb_array_elements_text(${devices}::jsonb))) AS "deviceCount"
 FROM device_groups g WHERE (${boundary}) AND ((${assignmentTargets}) OR EXISTS (
  SELECT 1 FROM device_group_ancestors path WHERE path.ancestor_id=g.id AND (
   path.group_id IN (SELECT value FROM jsonb_array_elements_text(${scopes}::jsonb)) OR EXISTS (
    SELECT 1 FROM device_group_members m JOIN servers s ON s.id=m.server_id
    WHERE m.group_id=path.group_id AND s.revoked=0 AND s.id IN (SELECT value FROM jsonb_array_elements_text(${devices}::jsonb))
   )
  )
 )) ORDER BY g.name,g.id`);
 // stepUpOnDelete: whether deleting the group asks for a fresh MFA proof
 // (deviceGroupDeleteNeedsStepUp, lib/step-up.ts); the console opens the dialog first only then.
 return Promise.all(rows.map(async ({hasMembers,hasAssignments,...group})=>({...group,stepUpOnDelete:deviceGroupDeleteNeedsStepUp({hasMembers:!!hasMembers,hasAssignments:!!hasAssignments}),permissions:await groupPermissions(viewer,group.id)})));
}

// Assignment administrators already receive these names from /api/rbac. Keep
// their navigation targets separate from monitoring records: this projection
// deliberately has no snapshot, timestamps, management state or measurements.
export async function devicePermissionTargets(viewer:Viewer):Promise<DevicePermissionTarget[]|undefined>{
 if(!await hasGlobalPermission(viewer,'portal.roleAssignments.manage'))return undefined;
 const me=sql`${principal(viewer)}`,assignmentTargets=globalPermissionGuard(me,'portal.roleAssignments.manage'),boundary=customerAccessGuard(sql`s.customer_id`,me);
 const rows=await db().query<{id:string;name:string;customerId:string;groupId:string|null;groupName:string|null;groups:string}>(sql`SELECT s.id,s.name,s.customer_id AS "customerId",
 (SELECT m.group_id FROM device_group_members m JOIN device_groups g ON g.id=m.group_id WHERE m.server_id=s.id ORDER BY (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id) DESC,g.name,g.id LIMIT 1) AS "groupId",
 (SELECT g.name FROM device_group_members m JOIN device_groups g ON g.id=m.group_id WHERE m.server_id=s.id ORDER BY (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id) DESC,g.name,g.id LIMIT 1) AS "groupName",
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'parentId',g.parent_id,'depth',(SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id),'direct',EXISTS(SELECT 1 FROM device_group_members direct WHERE direct.server_id=s.id AND direct.group_id=g.id))),'[]'::jsonb) FROM device_groups g WHERE EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id=s.id AND a.ancestor_id=g.id)) AS groups
 FROM servers s WHERE s.revoked=0 AND (${boundary}) AND (${assignmentTargets}) ORDER BY s.name,s.id`);
 return rows.map(row=>({id:row.id,name:row.name,customerId:row.customerId,groupId:row.groupId,groupName:row.groupName,groups:JSON.parse(row.groups).map((group:{direct:boolean})=>({...group,direct:!!group.direct}))}));
}
