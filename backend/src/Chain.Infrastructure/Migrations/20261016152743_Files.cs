using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class Files : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "files",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    uploaded_by = table.Column<Guid>(type: "uuid", nullable: false),
                    instance_id = table.Column<Guid>(type: "uuid", nullable: true),
                    attached_to_kind = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    attached_to_id = table.Column<Guid>(type: "uuid", nullable: true),
                    original_name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    scan_status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    attached_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_files", x => x.id);
                    table.CheckConstraint("ck_files_attachment", "(status = 'pending' AND instance_id IS NULL AND attached_to_kind IS NULL AND attached_to_id IS NULL AND attached_at IS NULL) OR (status = 'attached' AND instance_id IS NOT NULL AND attached_to_kind IN ('comment', 'submission') AND attached_to_id IS NOT NULL AND attached_at IS NOT NULL)");
                    table.CheckConstraint("ck_files_scan", "scan_status IN ('not_scanned', 'clean', 'infected')");
                    table.CheckConstraint("ck_files_status", "status IN ('pending', 'attached')");
                    table.ForeignKey(
                        name: "fk_files_instances_instance_id",
                        column: x => x.instance_id,
                        principalSchema: "chain",
                        principalTable: "instances",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_files_users_uploaded_by",
                        column: x => x.uploaded_by,
                        principalSchema: "chain",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "file_contents",
                schema: "chain",
                columns: table => new
                {
                    file_id = table.Column<Guid>(type: "uuid", nullable: false),
                    content = table.Column<byte[]>(type: "bytea", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_file_contents", x => x.file_id);
                    table.ForeignKey(
                        name: "fk_file_contents_files_file_id",
                        column: x => x.file_id,
                        principalSchema: "chain",
                        principalTable: "files",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_files_instance_id",
                schema: "chain",
                table: "files",
                column: "instance_id");

            migrationBuilder.CreateIndex(
                name: "ix_files_status_created_at",
                schema: "chain",
                table: "files",
                columns: new[] { "status", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_files_uploaded_by",
                schema: "chain",
                table: "files",
                column: "uploaded_by");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "file_contents",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "files",
                schema: "chain");
        }
    }
}
