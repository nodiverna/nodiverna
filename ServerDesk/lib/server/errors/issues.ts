// Field paths of validation issues for an error param. The answer names the
// fields only, never the validator's message text, which may be in any language.
type Issue={readonly path:readonly PropertyKey[]};

/** The first `limit` issue paths, joined by ", "; the root of the input is "(root)". */
export function issueFields(issues:readonly Issue[],limit:number):string{
 return issues.slice(0,limit).map(issue=>issue.path.map(String).join('.')||'(root)').join(', ');
}
