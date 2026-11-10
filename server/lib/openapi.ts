/**
 * A hand-kept OpenAPI 3.1 description of the part of the API meant for outside tools (an AI assistant) using an
 * API key. It lists the useful read calls and the main write calls; responses are described loosely on purpose
 * (the portal's screens use the same routes and their shapes grow). Every route still checks its own right.
 */
type Op = { summary: string; right: string; write?: boolean; params?: Array<[string, "path" | "query", string]>; body?: Record<string, string> };

const OPS: Array<[string, "get" | "post" | "patch" | "put" | "delete", Op]> = [
  ["/api/me", "get", { summary: "Who the key acts as and the rights it carries", right: "any" }],
  ["/api/search", "get", { summary: "Search tickets, clients, contacts, devices, projects, invoices, quotes, tasks (2 characters at least)", right: "per kind", params: [["q", "query", "Text to find"]] }],
  ["/api/tickets", "get", { summary: "List tickets the key may see (open ones by default)", right: "tickets.view", params: [["view", "query", "mine | all | unassigned | due ..."], ["q", "query", "Search text"], ["sort", "query", "Sort name"]] }],
  ["/api/tickets/{id}", "get", { summary: "One ticket with its notes, time, charges and checklist", right: "tickets.view", params: [["id", "path", "Ticket id"]] }],
  ["/api/tickets", "post", { summary: "Create a ticket", right: "tickets.edit", write: true, body: { title: "string", description: "string?", companyId: "number (required)", priority: "string (required)", assigneeId: "string|null (required)", dueDate: "YYYY-MM-DD (required)" } }],
  ["/api/tickets/{id}", "patch", { summary: "Change a ticket: status, priority, assigneeId, dueDate, queue...", right: "tickets.edit", write: true, params: [["id", "path", "Ticket id"]], body: { status: "string?", priority: "string?", assigneeId: "string|null?", dueDate: "YYYY-MM-DD?", queue: "string?" } }],
  ["/api/tickets/{id}/notes", "post", { summary: "Add a note. Set internal:true for a team-only note. Set email:false so no email goes to the client.", right: "tickets.edit", write: true, params: [["id", "path", "Ticket id"]], body: { text: "string", internal: "boolean", email: "boolean?" } }],
  ["/api/crm/clients", "get", { summary: "List clients", right: "crm.view" }],
  ["/api/crm/clients/{id}", "get", { summary: "One client", right: "crm.view", params: [["id", "path", "Client id"]] }],
  ["/api/crm/clients/{id}/contacts", "get", { summary: "A client's contacts", right: "crm.view", params: [["id", "path", "Client id"]] }],
  ["/api/crm/clients/{id}", "patch", { summary: "Change a client", right: "crm.edit", write: true, params: [["id", "path", "Client id"]], body: { name: "string?", phone: "string?", email: "string?" } }],
  ["/api/projects", "get", { summary: "List projects", right: "projects.view" }],
  ["/api/projects/{id}", "get", { summary: "One project with its phases, tasks and notes", right: "projects.view", params: [["id", "path", "Project id (uuid)"]] }],
  ["/api/pipeline/tasks", "get", { summary: "To-do tasks (scope=mine|all, status=open|done|all, q)", right: "pipeline.view", params: [["scope", "query", "mine | all"], ["status", "query", "open | done | all"], ["q", "query", "Search text"]] }],
  ["/api/pipeline/tasks", "post", { summary: "Create a to-do task", right: "pipeline.edit", write: true, body: { title: "string", notes: "string?", dueDate: "YYYY-MM-DD?", priority: "string?" } }],
  ["/api/quotes", "get", { summary: "List quotes", right: "quotes.view" }],
  ["/api/crm/invoices", "get", { summary: "List invoices (status, clientId, from, to, q)", right: "accounting.view", params: [["status", "query", "open | due | overdue | partial | paid | voided"], ["clientId", "query", "Client id"], ["q", "query", "Search text"]] }],
  ["/api/newsletter/subscribers", "get", { summary: "Newsletter list: every client contact with an email who has not unsubscribed, each with an unsubscribeUrl to put at the bottom of that person's newsletter", right: "newsletter.view" }],
  ["/api/newsletter/optouts", "post", { summary: "Unsubscribe (unsubscribed:true) or resubscribe (false) an address by hand", right: "newsletter.manage", write: true, body: { email: "string", unsubscribed: "boolean" } }],
  ["/api/newsletter/issues", "post", { summary: "Record a newsletter that was just sent, so the team can answer clients' questions: subject, body (as sent), sentAt (ISO, optional), recipients (list of emails, optional), recipientCount (optional)", right: "newsletter.log", write: true, body: { subject: "string", body: "string (HTML or text, as sent)", sentAt: "ISO date?", recipients: "string[]?", recipientCount: "number?" } }],
  ["/api/newsletter/issues", "get", { summary: "The newsletters already sent (optional email filter: only those sent to that address)", right: "newsletter.view", params: [["email", "query", "Only the issues sent to this address"]] }],
  ["/api/meetings/overdue", "get", { summary: "Overdue and due-this-week ticket gauges", right: "meetings.view" }],
];

export function openApiSpec(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, method, op] of OPS) {
    paths[path] ??= {};
    paths[path][method] = {
      summary: op.summary,
      description: `Right needed: ${op.right}.${op.write ? " The key must allow writing." : ""}`,
      "x-required-right": op.right,
      parameters: (op.params ?? []).map(([name, where, description]) => ({ name, in: where, required: where === "path", description, schema: { type: "string" } })),
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(Object.entries(op.body).map(([k, v]) => [k, { type: "string", description: v }])) } } } } } : {}),
      responses: { "200": { description: "OK (JSON)" }, "401": { description: "Missing, bad, revoked or expired key" }, "403": { description: "Right not on the key, or read-only key (api_key_read_only)" }, "429": { description: "More than 120 calls a minute" } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "AKAB Portal API", version: "1", description: "Read and change portal data with an API key (Admin > API keys). A key acts with only the rights ticked on it, and is read only unless writing was allowed. Request bodies are JSON. Shapes are loose: inspect responses." },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Key starting with akab_" } } },
    paths,
  };
}
