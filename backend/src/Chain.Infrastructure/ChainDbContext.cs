using Chain.Forms;
using Chain.Identity;
using Chain.Infrastructure.Files;
using Chain.Workflows.Files;
using Chain.Workflows.Modeling;
using Chain.Workflows.Runtime;
using Microsoft.EntityFrameworkCore;

namespace Chain.Infrastructure;

/// <summary>Persistence for the <c>chain</c> schema, owned by the .NET core (ADR-0005).</summary>
public sealed class ChainDbContext(DbContextOptions<ChainDbContext> options) : DbContext(options)
{
    public const string Schema = "chain";

    public DbSet<User> Users => Set<User>();
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<AuditEventRow> AuditEvents => Set<AuditEventRow>();
    public DbSet<McpRateWindowRow> McpRateWindows => Set<McpRateWindowRow>();
    public DbSet<McpCallRow> McpCalls => Set<McpCallRow>();
    public DbSet<Group> Groups => Set<Group>();
    public DbSet<GroupMember> GroupMembers => Set<GroupMember>();
    public DbSet<BotToken> BotTokens => Set<BotToken>();
    public DbSet<PlatformGrant> PlatformGrants => Set<PlatformGrant>();
    public DbSet<WorkflowDefinition> WorkflowDefinitions => Set<WorkflowDefinition>();
    public DbSet<WorkflowVersion> WorkflowVersions => Set<WorkflowVersion>();
    public DbSet<WorkflowGrant> WorkflowGrants => Set<WorkflowGrant>();
    public DbSet<Instance> Instances => Set<Instance>();
    public DbSet<InstanceTask> InstanceTasks => Set<InstanceTask>();
    public DbSet<InstanceParticipant> InstanceParticipants => Set<InstanceParticipant>();
    public DbSet<InstanceEvent> InstanceEvents => Set<InstanceEvent>();
    public DbSet<IdempotencyKeyRow> IdempotencyKeys => Set<IdempotencyKeyRow>();
    public DbSet<FormDefinition> FormDefinitions => Set<FormDefinition>();
    public DbSet<FormVersion> FormVersions => Set<FormVersion>();
    public DbSet<InstanceSubmission> InstanceSubmissions => Set<InstanceSubmission>();
    public DbSet<InstanceIncident> InstanceIncidents => Set<InstanceIncident>();
    public DbSet<AutomationWorkRequest> AutomationWorkRequests => Set<AutomationWorkRequest>();
    public DbSet<AutomationResultRecord> AutomationResults => Set<AutomationResultRecord>();
    public DbSet<StoredFile> Files => Set<StoredFile>();
    public DbSet<Chain.Automations.Destination> AutomationDestinations => Set<Chain.Automations.Destination>();
    public DbSet<Chain.Automations.Secret> AutomationSecrets => Set<Chain.Automations.Secret>();
    public DbSet<Chain.Automations.AutomationDefinition> AutomationDefinitions => Set<Chain.Automations.AutomationDefinition>();
    public DbSet<Chain.Automations.AutomationVersion> AutomationVersions => Set<Chain.Automations.AutomationVersion>();

    private static Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<T, string> LowerCase<T>() where T : struct, Enum =>
        new(value => value.ToString().ToLowerInvariant(), text => Enum.Parse<T>(text, true));

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema(Schema);

        modelBuilder.Entity<User>(user =>
        {
            user.HasKey(u => u.Id);
            user.Property(u => u.Username).HasMaxLength(Username.MaxLength);
            user.HasIndex(u => u.Username).IsUnique();
            user.Property(u => u.DisplayName).HasMaxLength(DisplayName.MaxLength);
            user.Property(u => u.PasswordHash).HasMaxLength(512);
            user.Property<uint>("xmin").IsRowVersion(); // optimistic concurrency (ADR-0008 §2)
            user.Property(u => u.Kind)
                .HasConversion(kind => kind == ActorKind.Bot ? "bot" : "user", value => value == "bot" ? ActorKind.Bot : ActorKind.User)
                .HasMaxLength(10)
                .HasDefaultValue(ActorKind.User)
                .HasSentinel(ActorKind.User);
            user.HasOne<User>().WithMany().HasForeignKey(u => u.OwnerId).OnDelete(DeleteBehavior.Restrict);
            user.ToTable(table =>
            {
                table.HasCheckConstraint("ck_users_kind", "kind IN ('user', 'bot')");
                table.HasCheckConstraint("ck_users_bot_not_admin", "kind <> 'bot' OR NOT is_admin");
                table.HasCheckConstraint("ck_users_mcp_bots_only", "kind = 'bot' OR NOT mcp_enabled");
                table.HasCheckConstraint("ck_users_mcp_rate", "mcp_calls_per_minute IS NULL OR (kind = 'bot' AND mcp_calls_per_minute BETWEEN 1 AND 600)");
                table.HasCheckConstraint(
                    "ck_users_password_by_kind",
                    "(kind = 'bot' AND password_hash IS NULL) OR (kind = 'user' AND password_hash IS NOT NULL)");
            });
        });

        modelBuilder.Entity<BotToken>(token =>
        {
            token.HasKey(t => t.Id);
            token.Property(t => t.Label).HasMaxLength(BotToken.MaxLabelLength);
            token.Property(t => t.Prefix).HasMaxLength(8);
            token.HasIndex(t => t.Prefix).IsUnique();
            token.Property(t => t.TokenHash).HasMaxLength(64);
            token.HasIndex(t => t.BotId);
            token.HasOne<User>().WithMany().HasForeignKey(t => t.BotId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Session>(session =>
        {
            session.HasKey(s => s.Id);
            session.Property(s => s.TokenHash).HasMaxLength(64);
            session.HasIndex(s => s.TokenHash).IsUnique();
            session.HasIndex(s => s.UserId);
            session.HasOne<User>().WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<Group>(group =>
        {
            group.HasKey(g => g.Id);
            group.Property(g => g.Name).HasMaxLength(GroupName.MaxLength);
            group.Property(g => g.NormalizedName).HasMaxLength(GroupName.MaxLength);
            group.HasIndex(g => g.NormalizedName).IsUnique();
            group.Property(g => g.Description).HasMaxLength(Group.MaxDescriptionLength);
            group.Property<uint>("xmin").IsRowVersion();
        });

        modelBuilder.Entity<GroupMember>(member =>
        {
            member.HasKey(m => new { m.GroupId, m.UserId });
            member.HasIndex(m => m.UserId);
            member.HasOne<Group>().WithMany().HasForeignKey(m => m.GroupId).OnDelete(DeleteBehavior.Restrict);
            member.HasOne<User>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<PlatformGrant>(grant =>
        {
            grant.HasKey(g => new { g.GroupId, g.Capability });
            grant.Property(g => g.Capability).HasConversion(_ => "modeler", _ => PlatformCapability.Modeler).HasMaxLength(20);
            grant.HasOne<Group>().WithMany().HasForeignKey(g => g.GroupId).OnDelete(DeleteBehavior.Restrict);
            grant.ToTable(table => table.HasCheckConstraint("ck_platform_grants_capability", "capability IN ('modeler')"));
        });

        modelBuilder.Entity<WorkflowDefinition>(definition =>
        {
            definition.HasKey(d => d.Id);
            definition.Property(d => d.Name).HasMaxLength(WorkflowName.MaxLength);
            definition.Property(d => d.NormalizedName).HasMaxLength(WorkflowName.MaxLength);
            definition.HasIndex(d => d.NormalizedName).IsUnique();
            definition.Property(d => d.Description).HasMaxLength(WorkflowDefinition.MaxDescriptionLength);
            definition.Property(d => d.Draft).HasColumnType("jsonb");
            definition.Property<uint>("xmin").IsRowVersion();
        });

        modelBuilder.Entity<WorkflowVersion>(version =>
        {
            version.HasKey(v => v.Id);
            version.HasIndex(v => new { v.DefinitionId, v.VersionNumber }).IsUnique();
            version.Property(v => v.Document).HasColumnType("jsonb");
            version.Property(v => v.ContentHash).HasMaxLength(71);
            version.Property(v => v.SensitiveKeys).HasColumnType("text[]").HasDefaultValueSql("'{}'::text[]");
            version.HasOne<WorkflowDefinition>().WithMany().HasForeignKey(v => v.DefinitionId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<WorkflowGrant>(grant =>
        {
            grant.HasKey(g => new { g.DefinitionId, g.GroupId, g.Capability });
            grant.Property(g => g.Capability)
                .HasConversion(c => c.ToString().ToLowerInvariant(), v => Enum.Parse<WorkflowCapability>(v, true))
                .HasMaxLength(20);
            grant.HasOne<WorkflowDefinition>().WithMany().HasForeignKey(g => g.DefinitionId).OnDelete(DeleteBehavior.Restrict);
            grant.HasOne<Group>().WithMany().HasForeignKey(g => g.GroupId).OnDelete(DeleteBehavior.Restrict);
            grant.ToTable(table => table.HasCheckConstraint("ck_workflow_grants_capability", "capability IN ('start', 'view', 'close', 'comment', 'viewsensitive')"));
        });

        modelBuilder.Entity<Instance>(instance =>
        {
            instance.HasKey(i => i.Id);
            instance.Property(i => i.DefinitionName).HasMaxLength(WorkflowName.MaxLength);
            instance.Property(i => i.Status).HasConversion(LowerCase<InstanceStatus>()).HasMaxLength(20);
            instance.Property(i => i.CurrentNodeId).HasMaxLength(200);
            instance.Property(i => i.Data).HasColumnType("jsonb");
            instance.Property(i => i.ParentNodeId).HasMaxLength(200);
            instance.HasIndex(i => i.RequesterId);
            instance.HasIndex(i => i.ParentInstanceId);
            instance.HasOne<Instance>().WithMany().HasForeignKey(i => i.ParentInstanceId).OnDelete(DeleteBehavior.Restrict);
            instance.ToTable(t => t.HasCheckConstraint("ck_instances_parent", "(parent_instance_id IS NULL) = (parent_node_id IS NULL) AND depth >= 0"));
            instance.HasIndex(i => new { i.DefinitionId, i.Status });
            instance.HasOne<WorkflowDefinition>().WithMany().HasForeignKey(i => i.DefinitionId).OnDelete(DeleteBehavior.Restrict);
            instance.HasOne<User>().WithMany().HasForeignKey(i => i.RequesterId).OnDelete(DeleteBehavior.Restrict);
            instance.Property<uint>("xmin").IsRowVersion();
        });

        modelBuilder.Entity<InstanceTask>(task =>
        {
            task.ToTable("instance_tasks");
            task.HasKey(t => t.Id);
            task.Property(t => t.NodeId).HasMaxLength(200);
            task.Property(t => t.Label).HasMaxLength(200);
            task.Property(t => t.Kind).HasConversion(LowerCase<TaskKindAtNode>()).HasMaxLength(20);
            task.Property(t => t.Status).HasConversion(LowerCase<TaskState>()).HasMaxLength(20);
            task.HasIndex(t => new { t.InstanceId, t.Status });
            task.HasIndex(t => new { t.GroupId, t.Status });
            task.HasOne<Instance>().WithMany().HasForeignKey(t => t.InstanceId).OnDelete(DeleteBehavior.Restrict);
            task.Property<uint>("xmin").IsRowVersion();
        });

        modelBuilder.Entity<InstanceParticipant>(participant =>
        {
            participant.HasKey(p => new { p.InstanceId, p.ActorId });
            participant.HasIndex(p => p.ActorId);
            participant.HasOne<Instance>().WithMany().HasForeignKey(p => p.InstanceId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<InstanceEvent>(instanceEvent =>
        {
            instanceEvent.HasKey(e => e.Id);
            instanceEvent.HasIndex(e => new { e.InstanceId, e.Sequence }).IsUnique();
            instanceEvent.Property(e => e.Type).HasMaxLength(50);
            instanceEvent.Property(e => e.Details).HasColumnType("jsonb");
            instanceEvent.Property(e => e.Channel).HasMaxLength(3);
            instanceEvent.ToTable(table => table.HasCheckConstraint("ck_instance_events_channel", "channel IN ('ui', 'api', 'mcp')"));
            instanceEvent.HasOne<Instance>().WithMany().HasForeignKey(e => e.InstanceId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<IdempotencyKeyRow>(key =>
        {
            key.ToTable("idempotency_keys");
            key.HasKey(k => new { k.ActorId, k.Key });
            key.Property(k => k.Key).HasMaxLength(200);
            key.Property(k => k.RequestHash).HasMaxLength(64);
            key.Property(k => k.ResultJson).HasColumnType("jsonb");
            key.HasIndex(k => k.CreatedAt);
        });

        modelBuilder.Entity<InstanceSubmission>(submission =>
        {
            submission.HasKey(s => s.Id);
            submission.Property(s => s.Kind).HasConversion(LowerCase<SubmissionKind>()).HasMaxLength(20).HasDefaultValue(SubmissionKind.Submission);
            submission.Property(s => s.NodeId).HasMaxLength(200);
            submission.Property(s => s.Values).HasColumnType("jsonb");
            submission.Property(s => s.Justification).HasMaxLength(InstanceSubmission.MaxJustificationLength);
            submission.Property(s => s.IncidentIds).HasColumnType("jsonb");
            submission.Property(s => s.Changes).HasColumnType("jsonb");
            submission.ToTable(table => table.HasCheckConstraint(
                "ck_instance_submissions_kind",
                "(kind = 'submission' AND form_id IS NOT NULL AND form_version IS NOT NULL AND justification IS NULL AND incident_ids IS NULL AND changes IS NULL)"
                + " OR (kind = 'correction' AND form_id IS NULL AND form_version IS NULL AND task_id IS NULL"
                + " AND justification IS NOT NULL AND incident_ids IS NOT NULL AND changes IS NOT NULL)"));
            submission.HasIndex(s => s.InstanceId);
            submission.HasOne<Instance>().WithMany().HasForeignKey(s => s.InstanceId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<InstanceIncident>(incident =>
        {
            incident.HasKey(i => i.Id);
            incident.Property(i => i.NodeId).HasMaxLength(200);
            incident.Property(i => i.Code).HasMaxLength(50);
            incident.Property(i => i.Message).HasMaxLength(1000);
            incident.Property(i => i.Resolution).HasMaxLength(20);
            incident.HasIndex(i => i.InstanceId);
            incident.HasOne<Instance>().WithMany().HasForeignKey(i => i.InstanceId).OnDelete(DeleteBehavior.Restrict);
        });

        // The automation outbox (automation.md §6.2, automation-contract.md §2.1); Elixir reads it through chain.automation_dispatch_v1.
        modelBuilder.Entity<AutomationWorkRequest>(request =>
        {
            request.ToTable("automation_work_requests", table =>
            {
                table.HasCheckConstraint("ck_automation_work_requests_kind", "kind IN ('execute', 'cancel')");
                table.HasCheckConstraint("ck_automation_work_requests_status", "status IN ('pending', 'completed', 'failed', 'cancelled', 'timed_out')");
                table.HasCheckConstraint("ck_automation_work_requests_shape",
                    "(kind = 'execute' AND payload IS NOT NULL AND idempotency_key IS NOT NULL AND cancels_request_id IS NULL) OR " +
                    "(kind = 'cancel' AND payload IS NULL AND idempotency_key IS NULL AND cancels_request_id IS NOT NULL)");
                table.HasCheckConstraint("ck_automation_work_requests_activation", "activation >= 1");
            });
            request.HasKey(r => r.Id);
            request.Property(r => r.Kind).HasMaxLength(10);
            request.Property(r => r.Status).HasMaxLength(20);
            request.Property(r => r.NodeId).HasMaxLength(200);
            request.Property(r => r.Payload).HasColumnType("jsonb");
            request.Property(r => r.IdempotencyKey).HasMaxLength(100);
            request.HasOne<Instance>().WithMany().HasForeignKey(r => r.InstanceId).OnDelete(DeleteBehavior.Restrict);
            request.HasOne<AutomationWorkRequest>().WithMany().HasForeignKey(r => r.CancelsRequestId).OnDelete(DeleteBehavior.Restrict);
            request.HasIndex(r => r.InstanceId).IsUnique().HasFilter("kind = 'execute' AND status = 'pending'").HasDatabaseName("ux_automation_work_requests_one_pending_execute");
            request.HasIndex(r => new { r.InstanceId, r.NodeId, r.Activation }).IsUnique().HasFilter("kind = 'execute'").HasDatabaseName("ux_automation_work_requests_activation");
            request.HasIndex(r => r.CreatedAt).HasFilter("status = 'pending'").HasDatabaseName("ix_automation_work_requests_pending");
        });

        // The result inbox (automation-contract.md §4.3): one row per request, never changed.
        modelBuilder.Entity<AutomationResultRecord>(result =>
        {
            result.ToTable("automation_results");
            result.HasKey(r => r.RequestId);
            result.Property(r => r.PayloadHash).HasMaxLength(71);
            result.Property(r => r.Response).HasColumnType("jsonb");
            result.HasOne<AutomationWorkRequest>().WithOne().HasForeignKey<AutomationResultRecord>(r => r.RequestId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<FormDefinition>(form =>
        {
            form.HasKey(f => f.Id);
            form.Property(f => f.Name).HasMaxLength(FormName.MaxLength);
            form.Property(f => f.NormalizedName).HasMaxLength(FormName.MaxLength);
            form.HasIndex(f => f.NormalizedName).IsUnique();
            form.Property(f => f.Description).HasMaxLength(FormDefinition.MaxDescriptionLength);
            form.Property(f => f.Draft).HasColumnType("jsonb");
            form.Property<uint>("xmin").IsRowVersion();
        });

        modelBuilder.Entity<FormVersion>(version =>
        {
            version.HasKey(v => v.Id);
            version.HasIndex(v => new { v.DefinitionId, v.VersionNumber }).IsUnique();
            version.Property(v => v.Document).HasColumnType("jsonb");
            version.Property(v => v.ContentHash).HasMaxLength(71);
            version.HasOne<FormDefinition>().WithMany().HasForeignKey(v => v.DefinitionId).OnDelete(DeleteBehavior.Restrict);
        });

        // Automation destinations and secrets (automation.md §3–§4; ADR-0012).
        modelBuilder.Entity<Chain.Automations.Destination>(destination =>
        {
            destination.ToTable("automation_destinations", table =>
            {
                table.HasCheckConstraint("ck_automation_destinations_scheme", "scheme IN ('https', 'http') AND (scheme = 'https' OR internal)");
                table.HasCheckConstraint("ck_automation_destinations_secrets_over_http", "NOT allow_secrets_over_http OR scheme = 'http'");
                table.HasCheckConstraint("ck_automation_destinations_port", "port IS NULL OR port BETWEEN 1 AND 65535");
                table.HasCheckConstraint(
                    "ck_automation_destinations_sizes",
                    "max_request_bytes BETWEEN 1024 AND 10485760 AND max_response_bytes BETWEEN 1024 AND 10485760");
            });
            destination.HasKey(d => d.Name);
            destination.Property(d => d.Name).HasMaxLength(64);
            destination.Property(d => d.Description).HasMaxLength(Chain.Automations.Destination.MaxDescriptionLength);
            destination.Property(d => d.Scheme).HasMaxLength(5);
            destination.Property(d => d.Host).HasMaxLength(253);
            destination.Property(d => d.PathPrefix).HasMaxLength(Chain.Automations.Destination.MaxPathPrefixLength);
            destination.HasOne<User>().WithMany().HasForeignKey(d => d.CreatedBy).OnDelete(DeleteBehavior.Restrict);
            destination.Property<uint>("xmin").IsRowVersion();
        });

        modelBuilder.Entity<Chain.Automations.Secret>(secret =>
        {
            secret.ToTable("automation_secrets", table =>
            {
                table.HasCheckConstraint("ck_automation_secrets_version", "version >= 1");
                table.HasCheckConstraint("ck_automation_secrets_envelope", "octet_length(nonce) = 12 AND octet_length(wrapped_data_key) = 60 AND octet_length(ciphertext) > 16");
            });
            secret.HasKey(s => s.Name);
            secret.Property(s => s.Name).HasMaxLength(64);
            secret.Property(s => s.Description).HasMaxLength(Chain.Automations.Secret.MaxDescriptionLength);
            secret.Property(s => s.AllowedDestinations).HasColumnType("text[]");
            secret.Property(s => s.KeyId).HasMaxLength(32);
            secret.Ignore(s => s.Sealed);
            secret.HasOne<User>().WithMany().HasForeignKey(s => s.CreatedBy).OnDelete(DeleteBehavior.Restrict);
            secret.Property<uint>("xmin").IsRowVersion();
        });

        // Automation definitions (automation.md §5.1), stored as form definitions are.
        modelBuilder.Entity<Chain.Automations.AutomationDefinition>(automation =>
        {
            automation.HasKey(a => a.Id);
            automation.Property(a => a.Name).HasMaxLength(Chain.Automations.AutomationName.MaxLength);
            automation.Property(a => a.NormalizedName).HasMaxLength(Chain.Automations.AutomationName.MaxLength);
            automation.HasIndex(a => a.NormalizedName).IsUnique();
            automation.Property(a => a.Description).HasMaxLength(Chain.Automations.AutomationDefinition.MaxDescriptionLength);
            automation.Property(a => a.Draft).HasColumnType("jsonb");
            automation.Property<uint>("xmin").IsRowVersion();
        });

        modelBuilder.Entity<Chain.Automations.AutomationVersion>(version =>
        {
            version.HasKey(v => v.Id);
            version.HasIndex(v => new { v.DefinitionId, v.VersionNumber }).IsUnique();
            version.Property(v => v.Document).HasColumnType("jsonb");
            version.Property(v => v.ContentHash).HasMaxLength(71);
            version.Property(v => v.Destination).HasMaxLength(64);
            version.HasIndex(v => v.Destination);
            version.Property(v => v.Secrets).HasColumnType("text[]");
            version.HasOne<Chain.Automations.AutomationDefinition>().WithMany().HasForeignKey(v => v.DefinitionId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<StoredFile>(file =>
        {
            file.ToTable("files", table =>
            {
                table.HasCheckConstraint("ck_files_status", "status IN ('pending', 'attached')");
                table.HasCheckConstraint("ck_files_scan", "scan_status IN ('not_scanned', 'clean', 'infected')");
                table.HasCheckConstraint(
                    "ck_files_attachment",
                    "(status = 'pending' AND instance_id IS NULL AND attached_to_kind IS NULL AND attached_to_id IS NULL AND attached_at IS NULL) OR (status = 'attached' AND instance_id IS NOT NULL AND attached_to_kind IN ('comment', 'submission') AND attached_to_id IS NOT NULL AND attached_at IS NOT NULL)");
            });
            file.HasKey(row => row.Id);
            file.Property(row => row.Status).HasConversion(LowerCase<StoredFileStatus>()).HasMaxLength(20);
            file.Property(row => row.ScanStatus)
                .HasConversion(
                    value => value == ScanStatus.NotScanned ? "not_scanned" : value.ToString().ToLowerInvariant(),
                    value => value == "not_scanned" ? ScanStatus.NotScanned : Enum.Parse<ScanStatus>(value, true))
                .HasMaxLength(20);
            file.Property(row => row.AttachedToKind)
                .HasConversion(
                    value => value == null ? null : value.Value.ToString().ToLowerInvariant(),
                    value => value == null ? null : Enum.Parse<AttachmentTarget>(value, true))
                .HasMaxLength(20);
            file.Property(row => row.OriginalName).HasMaxLength(StoredFile.MaxNameLength);
            file.Property(row => row.ContentType).HasMaxLength(100);
            file.Property(row => row.Sha256).HasMaxLength(64);
            file.HasIndex(row => row.UploadedBy);
            file.HasIndex(row => row.InstanceId);
            file.HasIndex(row => new { row.Status, row.CreatedAt });
            file.HasOne<User>().WithMany().HasForeignKey(row => row.UploadedBy).OnDelete(DeleteBehavior.Restrict);
            file.HasOne<Instance>().WithMany().HasForeignKey(row => row.InstanceId).OnDelete(DeleteBehavior.Restrict);
            file.Property<uint>("xmin").IsRowVersion();
        });

        modelBuilder.Entity<FileContentRow>(content =>
        {
            content.ToTable("file_contents");
            content.HasKey(row => row.FileId);
            content.Property<byte[]>("Content").HasColumnType("bytea").IsRequired();
            content.HasOne<StoredFile>().WithOne().HasForeignKey<FileContentRow>(row => row.FileId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<McpRateWindowRow>(window =>
        {
            window.ToTable("mcp_rate_windows");
            window.HasKey(w => new { w.BotId, w.WindowStart });
        });

        modelBuilder.Entity<AuditEventRow>(audit =>
        {
            audit.ToTable("audit_events");
            audit.HasKey(a => a.Id);
            audit.Property(a => a.Action).HasMaxLength(100);
            audit.Property(a => a.Details).HasColumnType("jsonb");
            audit.Property(a => a.CorrelationId).HasMaxLength(64);
            audit.HasIndex(a => a.OccurredAt);
            audit.HasIndex(a => a.SubjectId);
        });

        modelBuilder.Entity<McpCallRow>(call =>
        {
            call.ToTable("mcp_calls");
            call.HasKey(c => c.Id);
            call.Property(c => c.Tool).HasMaxLength(64);
            call.Property(c => c.Outcome).HasMaxLength(64);
            call.Property(c => c.CorrelationId).HasMaxLength(64);
            call.Property(c => c.IdempotencyKey).HasMaxLength(200);
            call.Property(c => c.ClientName).HasMaxLength(200);
            call.Property(c => c.ClientVersion).HasMaxLength(200);
            call.Property(c => c.ArgumentsSha256).HasMaxLength(71);
            call.HasIndex(c => c.CalledAt);
        });
    }
}

/// <summary>A stored command result for idempotent replay (ADR-0008 §4).</summary>
public sealed class IdempotencyKeyRow
{
    public Guid ActorId { get; set; }
    public string Key { get; set; } = string.Empty;
    public string RequestHash { get; set; } = string.Empty;
    public string? ResultJson { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>A bot's MCP calls in one clock minute, counted for every API process (mcp.md §5).</summary>
public sealed class McpRateWindowRow
{
    public Guid BotId { get; set; }
    public DateTimeOffset WindowStart { get; set; }
    public int Calls { get; set; }
}

/// <summary>One row of the MCP call log (mcp.md §6.1), kept 90 days. The arguments are only hashed.</summary>
public sealed class McpCallRow
{
    public Guid Id { get; set; }
    public Guid BotId { get; set; }
    public string Tool { get; set; } = string.Empty;
    public string Outcome { get; set; } = string.Empty;
    public int DurationMs { get; set; }
    public string? CorrelationId { get; set; }
    public string? IdempotencyKey { get; set; }
    public string? ClientName { get; set; }
    public string? ClientVersion { get; set; }
    public string ArgumentsSha256 { get; set; } = string.Empty;
    public DateTimeOffset CalledAt { get; set; }
}

/// <summary>Append-only audit record (NFR-001).</summary>
public sealed class AuditEventRow
{
    public Guid Id { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
    public Guid? ActorId { get; set; }
    public string Action { get; set; } = string.Empty;
    public Guid? SubjectId { get; set; }
    public string Details { get; set; } = "{}";
    public string? CorrelationId { get; set; }
}
