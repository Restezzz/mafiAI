# Запускает CI/CD pipeline в GitLab через Pipeline Trigger Token.
#
# Использование:
#   .\scripts\run-pipeline.ps1                  # main (по умолчанию)
#   .\scripts\run-pipeline.ps1 -Branch main
#   .\scripts\run-pipeline.ps1 -Branch feature/some-branch
#
# Endpoint: POST /projects/:id/trigger/pipeline
# Документация: https://docs.gitlab.com/ee/ci/triggers/

param(
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$Token     = "glptt-dGgDkPUxi_JNYP8XAxss"
$ProjectId = "startsevkirill010101%2Fmafia-ai"
$ApiUrl    = "https://gitlab.com/api/v4/projects/$ProjectId/trigger/pipeline"

Write-Host "Triggering pipeline:" -ForegroundColor Cyan
Write-Host "  project: startsevkirill010101/mafia-ai"
Write-Host "  branch : $Branch"
Write-Host ""

$response = curl.exe --silent --show-error --fail-with-body `
    --request POST `
    --form "token=$Token" `
    --form "ref=$Branch" `
    $ApiUrl

if ($LASTEXITCODE -ne 0) {
    Write-Host "Pipeline trigger failed:" -ForegroundColor Red
    Write-Host $response
    exit $LASTEXITCODE
}

# GitLab возвращает JSON с web_url — выдёргиваем для удобства.
$json = $response | ConvertFrom-Json
Write-Host "Pipeline created:" -ForegroundColor Green
Write-Host "  id     : $($json.id)"
Write-Host "  status : $($json.status)"
Write-Host "  url    : $($json.web_url)"
