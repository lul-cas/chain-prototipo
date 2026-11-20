using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class BotsAndTokens : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterColumn<string>(
                name: "password_hash",
                schema: "chain",
                table: "users",
                type: "character varying(512)",
                maxLength: 512,
                nullable: true,
                oldClrType: typeof(string),
                oldType: "character varying(512)",
                oldMaxLength: 512);

            migrationBuilder.AddColumn<string>(
                name: "kind",
                schema: "chain",
                table: "users",
                type: "character varying(10)",
                maxLength: 10,
                nullable: false,
                defaultValue: "user");

            migrationBuilder.AddColumn<Guid>(
                name: "owner_id",
                schema: "chain",
                table: "users",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "bot_tokens",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    bot_id = table.Column<Guid>(type: "uuid", nullable: false),
                    label = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    prefix = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    token_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    last_used_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_bot_tokens", x => x.id);
                    table.ForeignKey(
                        name: "fk_bot_tokens_users_bot_id",
                        column: x => x.bot_id,
                        principalSchema: "chain",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_users_owner_id",
                schema: "chain",
                table: "users",
                column: "owner_id");

            migrationBuilder.AddCheckConstraint(
                name: "ck_users_bot_not_admin",
                schema: "chain",
                table: "users",
                sql: "kind <> 'bot' OR NOT is_admin");

            migrationBuilder.AddCheckConstraint(
                name: "ck_users_kind",
                schema: "chain",
                table: "users",
                sql: "kind IN ('user', 'bot')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_users_password_by_kind",
                schema: "chain",
                table: "users",
                sql: "(kind = 'bot' AND password_hash IS NULL) OR (kind = 'user' AND password_hash IS NOT NULL)");

            migrationBuilder.CreateIndex(
                name: "ix_bot_tokens_bot_id",
                schema: "chain",
                table: "bot_tokens",
                column: "bot_id");

            migrationBuilder.CreateIndex(
                name: "ix_bot_tokens_prefix",
                schema: "chain",
                table: "bot_tokens",
                column: "prefix",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "fk_users_users_owner_id",
                schema: "chain",
                table: "users",
                column: "owner_id",
                principalSchema: "chain",
                principalTable: "users",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_users_users_owner_id",
                schema: "chain",
                table: "users");

            migrationBuilder.DropTable(
                name: "bot_tokens",
                schema: "chain");

            migrationBuilder.DropIndex(
                name: "ix_users_owner_id",
                schema: "chain",
                table: "users");

            migrationBuilder.DropCheckConstraint(
                name: "ck_users_bot_not_admin",
                schema: "chain",
                table: "users");

            migrationBuilder.DropCheckConstraint(
                name: "ck_users_kind",
                schema: "chain",
                table: "users");

            migrationBuilder.DropCheckConstraint(
                name: "ck_users_password_by_kind",
                schema: "chain",
                table: "users");

            migrationBuilder.DropColumn(
                name: "kind",
                schema: "chain",
                table: "users");

            migrationBuilder.DropColumn(
                name: "owner_id",
                schema: "chain",
                table: "users");

            migrationBuilder.AlterColumn<string>(
                name: "password_hash",
                schema: "chain",
                table: "users",
                type: "character varying(512)",
                maxLength: 512,
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(string),
                oldType: "character varying(512)",
                oldMaxLength: 512,
                oldNullable: true);
        }
    }
}
