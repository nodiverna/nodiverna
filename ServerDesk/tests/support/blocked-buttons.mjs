// Blocked kit buttons in SSR markup (ui/kit/kit.tsx, Btn and IconBtn with `blocked`): they
// carry aria-disabled="true" instead of the native disabled attribute and name their reason with
// aria-describedby, which points to an sr-only element inside the button. The reason also shows in
// the Tooltip, which renders only in the browser.
const decode=text=>text.replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** The description of the element with these attributes: the text of the element its aria-describedby names, or null. */
export function describedBy(attributes,html){
 const id=attributes.match(/aria-describedby="([^"]+)"/)?.[1];
 if(!id)return null;
 const target=html.match(new RegExp(`id="${escape(id)}"[^>]*>([^<]*)<`));
 return target?decode(target[1]):null;
}

/** Every <button> in the markup with its attributes, inner markup, state and description. */
export function buttons(html){
 return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([outer,attributes,inner])=>({
  outer,attributes,inner,
  label:decode(attributes.match(/aria-label="([^"]*)"/)?.[1]??''),
  blocked:/\saria-disabled="true"/.test(attributes)&&!/\sdisabled=""/.test(attributes),
  disabled:/\sdisabled=""/.test(attributes),
  title:attributes.match(/\stitle="([^"]*)"/)?.[1]??null,
  description:describedBy(attributes,html),
 }));
}

/** The reasons of all blocked buttons in the markup, in order. */
export const blockedReasons=html=>buttons(html).filter(button=>button.blocked).map(button=>button.description);
