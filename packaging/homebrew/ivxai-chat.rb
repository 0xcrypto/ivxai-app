# Rendered by .github/workflows/homebrew.yml and pushed to ivxlabs/homebrew-tap
# as Casks/ivxai-chat.rb. __VERSION__ and __SHA256__ are filled in there.
cask "ivxai-chat" do
  version "__VERSION__"
  sha256 "__SHA256__"

  url "https://github.com/ivxlabs/ivxai-app/releases/download/v#{version}/ivxai-chat-v#{version}-macos-universal.dmg"
  name "ivx/ai Chat"
  desc "Chat UI for any LLM endpoint: no account, no backend, no telemetry"
  homepage "https://github.com/ivxlabs/ivxai-app"

  # A bare symbol is the minimum version; the ">= :big_sur" string form is
  # deprecated.
  depends_on macos: :big_sur

  app "ivxai Chat.app"

  # The app carries no paid developer certificate, so Homebrew's own quarantine
  # flag is what Gatekeeper will complain about. Say so rather than stripping it
  # behind the user's back.
  caveats <<~EOS
    This build is not signed or notarised. On first launch macOS will refuse it.
    Either right-click the app and choose Open, or reinstall without the
    quarantine flag:

      brew install --cask --no-quarantine ivxai-chat
  EOS

  zap trash: [
    "~/Library/Application Support/run.ivx.chat",
    "~/Library/Caches/run.ivx.chat",
    "~/Library/HTTPStorages/run.ivx.chat",
    "~/Library/Saved Application State/run.ivx.chat.savedState",
    "~/Library/WebKit/run.ivx.chat",
  ]
end
