// The Discord webhook URL rule (docs/notifications.md, "Discord"): pure, no
// server imports, so the server (lib/server/notifications/notification-channels.ts) and the channel
// form (ui/settings/notifications-panel.tsx) use the same rule and cannot drift.
// A Discord webhook URL is an https: URL without user info and without an
// explicit port, on one of the Discord hosts, with the path
// /api[/v<digits>]/webhooks/<digits>/<token>[/]. A query string is allowed
// (for example ?thread_id=…).

/** The hosts that serve Discord webhooks; compared in lower case without a trailing dot. */
export const discordWebhookHosts:readonly string[]=['discord.com','discordapp.com','ptb.discord.com','canary.discord.com','ptb.discordapp.com','canary.discordapp.com'];
const discordWebhookPath=/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/;
const controlCharacters=/[\u0000-\u001f\u007f]/;

/**
 * Whether `value` is a Discord webhook URL. It includes the general target
 * rule of every URL channel (https:, no user info, at most 2048 characters,
 * no control characters), so the client gives the same answer as the server.
 */
export function isDiscordWebhookUrl(value:unknown):value is string{
 if(typeof value!=='string'||!value||value.length>2048||controlCharacters.test(value))return false;
 let url:URL;
 try{url=new URL(value);}catch{return false;}
 if(url.protocol!=='https:'||url.username||url.password)return false;
 // The URL parser drops a default port (:443); the raw authority must have none at all.
 // It also ignores leading and trailing spaces, so the raw check reads the trimmed text.
 const authority=/^https:\/\/([^/?#]*)/i.exec(value.trim())?.[1]??'';
 if(url.port||authority.includes(':'))return false;
 const host=url.hostname.toLowerCase().replace(/\.$/,'');
 return discordWebhookHosts.includes(host)&&discordWebhookPath.test(url.pathname);
}
