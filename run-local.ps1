$ErrorActionPreference = 'Stop'

$sdkList = & dotnet --list-sdks 2>$null
if ($LASTEXITCODE -ne 0 -or -not ($sdkList | Where-Object { $_ -match '^10\.' })) {
    Write-Error 'Install the .NET 10 SDK first: https://dotnet.microsoft.com/download/dotnet/10.0'
}

if ([string]::IsNullOrWhiteSpace($env:YouTube__ApiKey)) {
    $secureKey = Read-Host 'Paste your YouTube Data API key (input is hidden)' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        $env:YouTube__ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
}

if ([string]::IsNullOrWhiteSpace($env:YouTube__ApiKey)) {
    throw 'No API key was entered. Run the script again and paste your YouTube Data API key.'
}

dotnet run --launch-profile http
exit $LASTEXITCODE
