// The registration request of the console (POST /api/console, action 'enroll').
// The console passes its effects in, so the flow runs in tests without React.

/** What the form of the page Add device sends: customerId only once a second customer exists. */
export type EnrollInput={name:string;mode:'ReadOnly'|'Management';groupId:string;customerId?:string};

/** The request body: groupId or null, customerId only when chosen, managementToken only on the step-up retry. */
export function enrollBody(input:EnrollInput&{managementToken?:string}){
 return {action:'enroll',name:input.name,mode:input.mode,agentVersion:4,format:'json',groupId:input.groupId||null,...(input.customerId?{customerId:input.customerId}:{}),...(input.managementToken?{managementToken:input.managementToken}:{})};
}

/**
 * The server asks for a customer: a second customer was created while the page
 * was open (ENROLL_CUSTOMER_REQUIRED). Branches on the code, never on the text.
 */
export const enrollCustomerRequired=(failure:unknown)=>typeof failure==='object'&&failure!==null&&(failure as {code?:unknown}).code==='ENROLL_CUSTOMER_REQUIRED';

export type EnrollEffects={
 post:(body:ReturnType<typeof enrollBody>)=>Promise<Response>;
 /** The error for an answer that is not ok (an ApiError with status and code). */
 failure:(response:Response)=>Promise<Error>;
 /** Download the file, confirm and report the registration to the page. */
 created:(response:Response)=>Promise<void>|void;
 /** Opens the MFA dialog for a step-up answer and returns true; false for every other error. */
 stepUp:(failure:unknown)=>boolean;
 error:(message:string)=>void;
 refresh:()=>Promise<unknown>;
 fallback:string;
};

/**
 * Sends one registration. Only `created` ends the form: on an error the form
 * keeps its input. ENROLL_CUSTOMER_REQUIRED also reloads the console data, so
 * the customer field appears.
 */
export async function submitEnrollment(input:EnrollInput&{managementToken?:string},effects:EnrollEffects):Promise<void>{
 try{
  const response=await effects.post(enrollBody(input));
  if(!response.ok)throw await effects.failure(response);
  await effects.created(response);
 }catch(failure){
  if(effects.stepUp(failure))return;
  effects.error(failure instanceof Error?failure.message:effects.fallback);
  if(enrollCustomerRequired(failure))await effects.refresh();
 }
}
