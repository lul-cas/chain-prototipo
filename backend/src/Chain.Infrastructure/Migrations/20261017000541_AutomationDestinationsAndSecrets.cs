using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AutomationDestinationsAndSecrets : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "automation_destinations",
                schema: "chain",
                columns: table => new
                {
                    name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    scheme = table.Column<string>(type: "character varying(5)", maxLength: 5, nullable: false),
                    host = table.Column<string>(type: "character varying(253)", maxLength: 253, nullable: false),
                    port = table.Column<int>(type: "integer", nullable: true),
                    path_prefix = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    @internal = table.Column<bool>(name: "internal", type: "boolean", nullable: false),
                    allow_secrets_over_http = table.Column<bool>(type: "boolean", nullable: false),
                    max_request_bytes = table.Column<long>(type: "bigint", nullable: false),
                    max_response_bytes = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_automation_destinations", x => x.name);
                    table.CheckConstraint("ck_automation_destinations_port", "port IS NULL OR port BETWEEN 1 AND 65535");
                    table.CheckConstraint("ck_automation_destinations_scheme", "scheme IN ('https', 'http') AND (scheme = 'https' OR internal)");
                    table.CheckConstraint("ck_automation_destinations_secrets_over_http", "NOT allow_secrets_over_http OR scheme = 'http'");
                    table.CheckConstraint("ck_automation_destinations_sizes", "max_request_bytes BETWEEN 1024 AND 10485760 AND max_response_bytes BETWEEN 1024 AND 10485760");
                    table.ForeignKey(
                        name: "fk_automation_destinations_users_created_by",
                        column: x => x.created_by,
                        principalSchema: "chain",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "automation_secrets",
                schema: "chain",
                columns: table => new
                {
                    name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    allowed_destinations = table.Column<string[]>(type: "text[]", nullable: false),
                    version = table.Column<int>(type: "integer", nullable: false),
                    nonce = table.Column<byte[]>(type: "bytea", nullable: false),
                    ciphertext = table.Column<byte[]>(type: "bytea", nullable: false),
                    wrapped_data_key = table.Column<byte[]>(type: "bytea", nullable: false),
                    key_id = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    rotated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_automation_secrets", x => x.name);
                    table.CheckConstraint("ck_automation_secrets_envelope", "octet_length(nonce) = 12 AND octet_length(wrapped_data_key) = 60 AND octet_length(ciphertext) > 16");
                    table.CheckConstraint("ck_automation_secrets_version", "version >= 1");
                    table.ForeignKey(
                        name: "fk_automation_secrets_users_created_by",
                        column: x => x.created_by,
                        principalSchema: "chain",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_automation_destinations_created_by",
                schema: "chain",
                table: "automation_destinations",
                column: "created_by");

            migrationBuilder.CreateIndex(
                name: "ix_automation_secrets_created_by",
                schema: "chain",
                table: "automation_secrets",
                column: "created_by");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "automation_destinations",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "automation_secrets",
                schema: "chain");
        }
    }
}
