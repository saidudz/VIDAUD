# prepare-installer-image.ps1
# Builds the NSIS installer sidebar (build/installerSidebar.bmp) from a custom
# design image (default: C:\Users\SAIDU\Downloads\Installer.png) and copies the
# source PNG into build/ so the design lives in the project as a real resource.
#
# The generated 164x314 BMP is embedded into the final VIDAUD-Setup.exe by
# electron-builder/NSIS (MUI_WELCOMEFINISHPAGE_BITMAP -> shown on the Welcome
# and "Completing VIDAUD Setup" pages), so it works on any Windows machine even
# if the original PNG is gone. Aspect ratio is preserved (contain) with padding
# matching the image edge color - nothing is stretched or cropped.
#
# Override the source image with the VIDAUD_INSTALLER_IMAGE environment variable.

$ErrorActionPreference = 'Stop'

$Root       = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BuildDir   = Join-Path $Root 'build'
$Source     = if ($env:VIDAUD_INSTALLER_IMAGE) { $env:VIDAUD_INSTALLER_IMAGE } else { 'C:\Users\SAIDU\Downloads\Installer.png' }

$SidebarName   = 'installerSidebar.bmp'
$SidebarPath   = Join-Path $BuildDir $SidebarName
$SidebarWidth  = 164
$SidebarHeight = 314

if (-not (Test-Path -LiteralPath $Source)) {
  if (Test-Path -LiteralPath $SidebarPath) {
    Write-Warning "Installer image not found: $Source - keeping existing $SidebarPath"
    exit 0
  }
  throw "Installer image not found: $Source and no existing sidebar to reuse"
}

New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
Copy-Item -LiteralPath $Source -Destination (Join-Path $BuildDir 'Installer.png') -Force

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile($Source)
$bmp = $null
try {
  $r = 0; $g = 0; $b = 0; $n = 0
  foreach ($row in @(0, ($src.Height - 1))) {
    for ($x = 0; $x -lt $src.Width; $x += 8) {
      $p = $src.GetPixel($x, $row)
      $r += $p.R; $g += $p.G; $b += $p.B; $n++
    }
  }
  $pad = [System.Drawing.Color]::FromArgb(255, [int]($r / $n), [int]($g / $n), [int]($b / $n))

  $bmp = New-Object System.Drawing.Bitmap($SidebarWidth, $SidebarHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $gfx.Clear($pad)
    $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gfx.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $gfx.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gfx.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $scale = [Math]::Min($SidebarWidth / $src.Width, $SidebarHeight / $src.Height)
    $w = [Math]::Max(1, [int][Math]::Round($src.Width * $scale))
    $h = [Math]::Max(1, [int][Math]::Round($src.Height * $scale))
    $x = [int](($SidebarWidth - $w) / 2)
    $y = [int](($SidebarHeight - $h) / 2)
    $gfx.DrawImage($src, $x, $y, $w, $h)
  } finally {
    $gfx.Dispose()
  }

  $sidebarPath = Join-Path $BuildDir $SidebarName
  $bmp.Save($sidebarPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  Write-Host "Installer image copied to $(Join-Path $BuildDir 'Installer.png')"
  Write-Host "NSIS sidebar written to $sidebarPath (${SidebarWidth}x${SidebarHeight}, aspect ratio preserved)"
} finally {
  $src.Dispose()
  if ($bmp -ne $null) { $bmp.Dispose() }
}
