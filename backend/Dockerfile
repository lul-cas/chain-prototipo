# Build stage
FROM mcr.microsoft.com/dotnet/sdk:10.0.302 AS build
WORKDIR /src
COPY global.json Directory.Build.props ./
# Copy all sources so every project referenced by Chain.Api is restored (no hand-maintained list to drift).
COPY src/ src/
RUN dotnet restore src/Chain.Api/Chain.Api.csproj
RUN dotnet publish src/Chain.Api/Chain.Api.csproj -c Release -o /app --no-restore

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:10.0.10 AS runtime
WORKDIR /app
COPY --from=build /app .
# 8080 is the public API; 8081 is the internal listener for automation results (automation-contract.md §4.1).
ENV ASPNETCORE_HTTP_PORTS=8080;8081
EXPOSE 8080 8081
USER app
ENTRYPOINT ["dotnet", "Chain.Api.dll"]
