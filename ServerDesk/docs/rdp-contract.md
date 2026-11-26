# Browser RDP transport contract (agent 4.3.4)

## Current release status: paused

The Remote Desktop function of the portal is paused. `lib/rdp-feature.ts` is the single switch for the UI and the server. The UI shows the placeholder **Paused**, also at the direct page URL. It does not mount the client or poll metadata. The admission of a new authenticated session returns HTTP 503 with `RDP_FEATURE_PAUSED`. While the function is paused, the live SQL guard refuses lease renewal and the dispatch of streams and negotiation.

In the device view, the Remote Desktop tab has the tag **Paused**. The placeholder has the action **Open terminal**, which opens the terminal subarea.

The normal cleanup of the portal and the agent closes and deletes existing sessions. Authenticated RDP polls of the agent still get HTTP 200 and closed or empty authoritative commands. Close and bounded diagnostics stay supported. No agent update, no change of the Windows RDP settings and no Windows logoff is necessary. The sections below describe the implementation that stays for a future reactivation.

The Node pipeline runs the `rdp-mailbox-timeout`, `rdp-ui-transport` and `rdp-webrtc-transport` fixtures. The device workspace checks make sure that the paused UI stays visible. The native fixtures for the RDP protocol and the firewall are part of the `--self-test` of the agent. These fixtures do not prove a full session from the browser to Windows. Production has no environment variable or request option that overrides the pause.

The default transport is a direct WebRTC data channel between the browser and the native agent. IronRDP still does the RDP decoding and the authentication of the Windows account. The agent still proxies only its own Windows RDP listener through the existing RDCleanPath and TLS boundary. Local accounts and permitted domain accounts keep the independent Windows logon behavior. This phase changes only the transport. It does not add console capture, H.264 video encoding or shared control of the console.

No additional VM, gateway container or manually configured relay is necessary. The portal supplies the authorization and the encrypted negotiation of the connection. A fixed public STUN endpoint finds the addresses of the peers. STUN does not carry screen or input traffic. The direct path needs a usable UDP route through the NAT and the firewalls of both peers.

This release has no TURN relay, so restrictive networks can prevent a connection. A failure is explicit. The portal never changes to the database transport without a message. The user can intentionally select the separate compatibility transport.

## Authorization and lifecycle

- A session needs the independent device permission `rdp`, an approved portal identity, current MFA, an online device and local Management. Direct sessions also need the agent capability `rdp-webrtc`, which comes with 4.3.0. Compatibility sessions need `rdp-browser`.
- Each session belongs to one principal and one device. The admission permits two concurrent sessions for each device and one session for each principal on that device. Windows logon rights, licensing and session limits of the OS stay authoritative.
- The absolute lifetime is two hours. Direct sessions get an authorization lease of 15 seconds or less. Connected browsers and agents normally send control requests every five seconds. During the opening negotiation, they poll every 250 ms. The browser presence of compatibility sessions keeps its grace period of 45 seconds.
- Each lease ends at the earliest of these times: the portal time plus 15 seconds, the session expiry, the last browser presence plus 15 seconds, the MFA idle expiry and the MFA absolute expiry. The agent enforces the absolute deadline locally. A delayed HTTP response cannot start a new lease. The browser also limits the lease to the start time of the request plus the returned remaining duration.
- The native agent calculates the remaining grant from the `Date` header of the authenticated HTTPS response. It subtracts the full monotonic age of the request. Before the key decryption, it converts the result one time to a `Stopwatch` deadline. The returned duration still limits the grant to 15 seconds, including the one-second rounding of the header. Clock differences on the device or local processing cannot make the grant longer.
- Signaling refreshes the browser presence, but not the MFA idle time. Agent traffic refreshes neither of them. The iframe forwards real keyboard and mouse activity to the MFA activity handler of the parent page.
- Each control dispatch and each guarded write checks these items: the current membership, the grants, MFA, the device capability and mode, maintenance and the lifetime. The native session also checks local Management and the update admission. If the renewal stops, the direct connection ends, also if screen traffic could still flow between the peers.
- The owner can close a session after MFA has expired. A different administrator needs current MFA and an explicit confirmation. Navigation, expiry, revocation and offboarding close the tunnel and delete the negotiation secrets. A disconnect does not end the Windows logon session of the user.
- Each native session holds `AgentUpdateLease.AcquireActivity` until its socket and its tasks have stopped. Agent updates cannot start while RDP is active. After a service restart, the agent rejects old session IDs. It does not resume or replay them.

## Browser API: direct transport

`GET /api/rdp?serverId=<uuid>` returns `{publicKey,sessions,activeSessions,availability,maxSessions:2}`. The public key is the current RSA JWK of the device. The API returns no private key. `availability.webrtcCapable` reports the direct capability, together with the availability of online, Management, RDP/NLA and policy. The session metadata includes its immutable `transport` (`webrtc` or `mailbox`).

The browser does these steps:

1. It makes a new canonical UUID and a random AES key of 32 bytes.
2. It encrypts the UTF-8 JSON `{id,key:<base64 32 bytes>}` with RSA-OAEP/SHA-256 for the public key of the device.
3. It gathers a WebRTC offer and seals its SDP.

The body to open a direct session has exactly six fields:

```js
{action:'open',id,serverId,keyEnvelope,transport:'webrtc',offer}
```

The username, the password and the domain stay in the browser memory, and IronRDP and CredSSP consume them. They are not fields of this API. The portal stores the sealed key and the sealed descriptions. After it accepts the answer, it deletes the key envelope.

A retry must use the identical key envelope, transport and sealed offer. A new connection needs a new UUID and key. A closed UUID cannot be used again.

`POST /api/rdp` with exactly `{action:'signal',id}` returns `{id,state,transport:'webrtc',answer?,error?,expiresAt,leaseExpiresAt,leaseMs,intervalMs}`. `expiresAt` and `leaseExpiresAt` are absolute ISO timestamps. `leaseMs` is the remaining authorization duration and is never more than 15,000 ms. The browser decrypts the answer one time and rejects a changed answer. Only the negotiation and the authorization go through this endpoint. Direct sessions reject `exchange` and `receive` requests.

Close stays `{action:'close',id,confirm?:true}`. Some events cancel the control polling, close the peer and release the session. These events are abort or unmount, a channel failure, invalid signaling, the lease expiry and a full bounded buffer. There is no transparent reconnection with an existing session or key.

## Agent API: direct transport

The native RDP channel starts after the portal acknowledges the capability heartbeat. The authentication with the token of a registered, not revoked agent is the same as for the existing agent endpoints. For HTTP failures, the local log keeps the status and bounded diagnostics.

`POST /api/agent/rdp` uses `{serverId,sessions:[report]}`. A direct report is:

```js
{id,transport:'webrtc',state:'opening'|'open'|'closed'|'error',inputAck:0,output:[],answer?,error?}
```

The reply contains `{sessions:[command],intervalMs}`. A live direct command is `{id,state,transport:'webrtc',expiresAt,leaseExpiresAt,leaseMs,input:[],outputAck:0,outputStored:0}`. While the session opens, the command also contains the sealed offer. Until the portal accepts the answer, it also contains the key envelope. The native session keeps its decrypted key and negotiation state, so the next commands do not need a new envelope.

Unknown or old IDs get a close command. The portal rejects these items: changed descriptions, a transport change, mailbox bytes in a direct report and a report for the incorrect transport.

Direct media does not start an HTTP request for each packet. The normal control interval of a connected session is five seconds. The interval during the opening is 250 ms. If a compatibility session is also active, the shared channel keeps the polling schedule of the compatibility session. The input and output arrays stay empty for direct sessions.

## Encrypted negotiation and direct bytes

Each direction has exactly one immutable SDP description. The new AES-256-GCM key of the session encrypts it:

- Offer nonce: ASCII `BOFR`, followed by the unsigned 64-bit big-endian value `1`. Answer nonce: ASCII `AANS`, followed by the same value. Both nonces have 12 bytes, and they are different from the frame nonces of the compatibility transport.
- AAD is exactly the UTF-8 text `ServerDesk:RDP:RTC:1:<session UUID>:offer` or `ServerDesk:RDP:RTC:1:<session UUID>:answer`.
- The plaintext is raw UTF-8 SDP with a maximum of 32,768 bytes. The ciphertext and the tag of 16 bytes use canonical standard base64. The portal input also has a strict limit of 65,536 characters. The browser and the native agent authenticate and decrypt, and they enforce the smaller plaintext limit.
- Do not encrypt a changed description with the fixed nonce. Retries use the original ciphertext again. The authenticated SDP contains the ICE credentials and the fingerprint of the DTLS certificate of the peer. Thus it binds the negotiated peer to the session key.

The browser creates one reliable, ordered data channel with the name `serverdesk-rdp-v1`. The agent rejects these items: a different label, unordered or partially reliable options, a second channel and the negotiated-channel mode. Both peers gather ICE candidates before they exchange their descriptions. The gathering has a limit of eight seconds. The configuration uses `stun:stun.cloudflare.com:3478` and no TURN server.

Then the opaque RDP bytes go directly through SCTP and DTLS. There is no HTTP polling for each packet, no base64 conversion, no database receipts for frames and no additional AES layer of the application. Direct sessions never insert into `rdp_frames` or `rdp_receipts`. Database triggers also block such inserts.

The database keeps only the authorization metadata of the session and the encrypted offer and answer. When a session reaches a terminal state, a trigger deletes its negotiation row. This also applies to the existing cleanup paths for membership and offboarding. The cleanup of historical sessions keeps no screen recording.

Application messages are binary and not empty, with a maximum of 16 KiB. The first CleanPath request must fit into one standalone message. Its `DER` response can use more than one message. The browser assembles the complete initial `DER` boundary before it gives it to IronRDP. After that, the byte order stays the same, and no RDP bytes are lost.

The browser staging and the inbound delivery have a limit of 1 MiB. The browser combines small SDK writes, including Blob parts, in sequence into messages of 16 KiB or less. The browser SCTP backpressure uses a high watermark of 512 KiB and a low watermark of 128 KiB.

The native inbound staging has two limits: 1 MiB and 64 messages. Before the native output reads more local TLS output, it waits until the SCTP send budget is below 512 KiB. An overflow or a broken stream closes the connection. Bytes are never lost without a message. The native output combination keeps the existing maximum flush delay of four milliseconds and cancels its pending read at the cleanup.

## Compatibility transport

The explicit compatibility option keeps the database mailbox protocol of 4.2. It can work with agents that advertise only `rdp-browser`. Its open body stays exactly `{action:'open',id,serverId,keyEnvelope}`. Without `transport`, the portal selects `mailbox`. It is a separate session and does not use the ID or key of a failed direct session again. Its latency and its database traffic stay higher than on the direct path.

The browser exchange is `{action:'exchange',id,ack,frames:[{seq,data}],receive?:false}`. It returns `{id,state,inputAck,inputStored,outputAck,frames,error?,intervalMs}`. The independent receive is `{action:'receive',id,ack,waitMs:<0..600>,inputAck?:<wake hint>}`. A maximum of 24 guarded reads wait for a maximum of 600 ms. The target is 30 ms between the starts of the reads.

The wake hint never changes database acknowledgments. Empty requests refresh the browser presence, but they do not renew the MFA idle time. Old combined exchanges keep their behavior.

The native legacy report is `{id,state,inputAck,output:[{seq,data}],error?}`. The command includes `keyEnvelope?`, `expiresAt`, input frames, `outputAck` and `outputStored`. Active legacy polling advertises 20 ms with data and 50 ms while the session is connected and idle. Agents without live sessions keep the idle interval of one second.

Compatibility frames use AES-256-GCM:

- The ciphertext and the tag of 16 bytes use standard base64.
- The nonce has 12 bytes. It is ASCII `CLNT` (browser to agent) or `AGNT` (agent to browser), followed by the unsigned 64-bit big-endian sequence.
- AAD is `ServerDesk:RDP:1:<UUID>:in:<seq>` or `ServerDesk:RDP:1:<UUID>:out:<seq>`.
- Sequences are positive safe integers and start at one. A repeated sequence must have identical ciphertext.
- Plain frames have a maximum of 16,384 bytes. Cipher frames have a maximum of 16,400 bytes (21,868 base64 characters).
- An exchange contains a maximum of 16 frames. Each direction has a maximum of 64 frames that are not consumed, approximately 1 MiB.

The portal enforces `consumed <= stored <= highestSent <= produced`. The stored ACK moves the upload selection forward. Only the consumed ACK releases end-to-end credit. Small hash receipts verify immutable retries after the payload ACK. The portal inserts frames and receipts and moves the sequence forward with guarded bulk writes in the same transaction.

The payloads are deleted at ACK, close or revocation. They expire after 45 seconds. Old data without acknowledgment closes the session. The cleanup runs during live control traffic, during metadata requests and admission, and in the existing dashboard cleanup.

When no requests run, no timed deletion occurs. The next cleanup deletes the expired ciphertext and the sealed keys. These records contain no password.

## RDCleanPath and Windows boundary

The official `DER` request uses explicit context tags: version `[0] INTEGER 3390`, destination `[2] UTF8String`, proxy auth `[3] UTF8String` and X.224 request `[6] OCTET STRING`. The logical destination must be `localhost:3389`. The auth token must be the current session UUID. The agent maps that destination only to its own RDP loopback port from the registry. The agent rejects other hosts, credential injection and malformed or too large input.

The agent forwards X.224 and reads the exact TPKT confirm. It requires NLA and CredSSP and upgrades only to TLS 1.2 or 1.3. The actual peer leaf must match `Win32_TSGeneralSetting.SSLCertificateSHA1Hash` of the local RDP listener and must have valid dates. There is no certificate callback that accepts all certificates.

The `DER` response contains `[0]3390`, `[6]original confirm`, `[7]sequence of actual DER certificates` and `[9]server address`. After that, the carrier relays the opaque local SslStream plaintext through its encrypted transport. RDP rendering, keyboard and mouse, and the authentication of the Windows account stay in IronRDP.

`set-rdp {enabled:boolean,confirm:true}` stays an explicit native management operation. To enable RDP, the operation needs Management. It obeys a blocking domain policy, enables NLA and TLS and starts the Windows RDP service. It does not open inbound RDP firewall rules. To disable RDP interrupts sessions, so it needs a confirmation.

NLA supports local accounts and domain accounts where NTLM is permitted. Protected Users and domain policies that permit only Kerberos need a future integration of a KDC proxy. Windows enforces the remote logon rights, the account restrictions, the licensing and the session limits of the OS.

## Connection setup and failure diagnosis

The parent page of the same origin marks its postMessage response envelope with bridge protocol 2. The client checks this after the metadata. It does this before it creates a key, gathers ICE or opens a direct session. An old dashboard that forwards a new backend response cannot claim the protocol through API metadata. In that case, the client offers an explicit refresh of the parent page.

An incorrect origin, source, device or request ID cannot change this value. The compatibility transport keeps its admission with four fields.

Agent 4.3.2 waits a maximum of eight seconds for the optional STUN discovery. Then it builds its one immutable answer from the available ICE candidates. A failed or blocked STUN must not discard a valid host candidate for a LAN or a VPN.

The browser also waits until the discovery is complete or until its discovery deadline of eight seconds. At the deadline, it keeps an SDP with candidates. It keeps one more second for the sealing, within its total setup budget of nine seconds.

The agent advertises usable addresses of all local interfaces in the encrypted description. This adds no public RDP firewall exception, no relay and no automatic fallback to the mailbox. If no direct route is available, the connection still needs an available network path or a supported relay infrastructure.

Agent 4.3.3 opens a Windows Firewall exception during an authorized direct session. The exception is for the actual WebRTC UDP socket and the current agent executable. It permits authenticated incoming ICE checks when an outgoing request cannot first make a return path. An example is a browser address behind multicast DNS that is not available.

The exception covers one UDP port. The agent removes it when it disposes that peer. The exception does not open the Windows RDP listener. Group policy and explicit blocks stay authoritative. A local firewall exception cannot help if there is no route, a restrictive external NAT or a network firewall.

Agent 4.3.4 recognizes the repeated registry form `Profile=Domain|Profile=Private|Profile=Public` of Windows when it verifies its local rule. The ownership fields and the scope of one port stay strict. COM ownership comparisons use the path casing of Windows and the documented forms for all profiles. Regression fixtures use the serialized form of Windows to test acquisition, cancellation, disposal and the cleanup of old rules.

Browser messages show different failures: a missing agent answer, an ICE failure, a DTLS or data channel failure and an interrupted connection. Before the cleanup, they copy bounded ICE, peer, DTLS and SCTP state values. They identify the event or the setup deadline with the elapsed setup time. Native errors contain only the phase, state enums, candidate counts and the exception type. They contain no SDP, no fingerprints, no candidate IPs and no contents of library exceptions.

A bounded diagnostic outbox keeps a final native RTC error in one case. The error occurred during an HTTP request, and the response of that request already closed the session or did not contain it. The outbox acknowledges the error only after a successful delivery. A recent terminal native RTC error can fill an empty diagnostic after the browser closed the session. This applies only to the same authenticated device. It does not restore the state, keys, descriptions or payloads.

Local signaling deadlines give typed timeout errors, not messages about a cancellation by the user. After a direct signaling timeout or a network interruption, the browser can try again one time. Authorization failures, protocol failures and cryptographic failures are terminal. The existing setup deadline and the absolute authorization lease stay in force during a retry. Only a valid control reply can renew a lease. The compatibility transport keeps its existing bounded retries with the exact kept ciphertext.

Agent 4.3.2 uses one monotonic deadline of twenty seconds for the initial ICE, DTLS and SCTP setup. The library can mark ICE as failed before the encrypted answer reaches the browser. An initial failure of only ICE can recover within this period while the authorization stays valid. Completed DTLS, an open data channel, an explicit close or disconnect and cryptographic errors never get this grace period. Later failures of an established connection also never get it. Gathering, answers, control replies and retries do not restart the deadline, and the agent checks the local authorization before the setup expires.

The periodic ICE check timer of the library can already have stopped at its earlier failure event. The recovery uses late authenticated connectivity checks from the browser. The browser consent, the data channel errors and the independent authorization lease continue to control the connection. Real peer fixtures cover the delayed recovery without trickle ICE. The consent of Windows and the browser and the behavior of idle networks stay part of the pilot.

After a generic failure of the direct setup, the browser can read the metadata of the owner for a maximum of three seconds. It does this to show a late native diagnostic. It accepts only the exact failed session ID, explicit ownership, the direct transport and a terminal state. This read does not renew the RDP presence, restore a session or overwrite a later connection. Specific errors for authorization, logon, protocol and cryptography stay.

## UI, dependencies and verification

A separate iframe of the same origin owns the WebSocket-compatible carrier that the real IronRDP engine uses. The global WebSocket of the portal does not change. The pinned browser packages are `@devolutions/iron-remote-desktop-rdp@0.7.0` and `@devolutions/iron-remote-desktop@0.11.0`.

The native agent includes SIPSorcery 10.0.17 for ICE, DTLS and SCTP in the self-contained executable. A separate installation by the user is not necessary. The full license of SIPSorcery includes a geographic restriction of use and distribution, together with BSD clauses. Keep the included third-party notices and review the full terms. Do not describe that license as an unrestricted BSD license.

The UI offers these functions: direct or compatibility transport, local or domain login, connect and disconnect, Ctrl+Alt+Del, fit or native size and full screen. The default desktop negotiation is 1280×720. The detail profile uses the host size with a maximum of 1920×1080. This changes the actual negotiated desktop size independently of the CSS scaling.

Clipboard, audio and device redirection are disabled by default. The browser storage contains no passwords and no keys of relays or sessions. The connection RTT describes the network path, not the rendered FPS.

Automated checks must cover these items:

- Encrypted immutable descriptions, the lease expiry and the guarded authorization.
- Cancellation, the binary order of the direct transport and the `DER` boundaries.
- Buffer limits, the real initial IronRDP handshake and the absence of mailbox payloads.

Native crypto and proxy fixtures and transport tests on the build host do not prove the Windows logon. They also do not prove that WebRTC works between the browser and the agent.

Before a wider rollout, do these steps:

1. Update Windows Server 2022 and 2025 and Windows 11 Pro or Enterprise devices that you can discard to 4.3.4.
2. Enable Management and RDP/NLA on these devices.
3. Test the local logon and the logon with a permitted domain account.
4. Test real rendering, mouse, keyboard, Unicode and Ctrl+Alt+Del.
5. Test scaling, full screen and account errors.
6. Measure the delay from input to screen, the throughput, the rendered FPS and the CPU.
7. Measure the traffic of the portal and the database on a LAN and across separate NAT networks.
8. Make sure that the direct setup fails on a restricted UDP network.
9. Make sure that the explicit selection of the compatibility transport works.
10. Test two portal users and existing Windows sessions.
11. Test a closed tab, a reconnection and the loss of the network or of control.
12. During a connection, test offboarding, the revocation of MFA or a grant, ReadOnly and the update admission.
13. Make sure that direct streaming ends at the lease deadline when the portal is not available.
14. Make sure that the Windows logon session of the user stays after a disconnect.
15. Make sure that the agent removes the exact UDP rule at the disposal.
16. Make sure that no public RDP firewall exception is added.
17. Check the cleanup after a crash of the service, and check profiles that Windows policy controls.

Real pilot results from Windows and browsers stay necessary. The transport implementation alone does not claim a target frame rate.
