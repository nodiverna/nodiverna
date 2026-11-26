using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal interface IRdpAgentSession : IAsyncDisposable
{
    string Id { get; }
    bool Alive { get; }
    bool Expired { get; }
    bool IsDirect { get; }
    bool HasPendingOutput { get; }
    JsonObject Snapshot();
    void Accept(JsonObject command);
}
