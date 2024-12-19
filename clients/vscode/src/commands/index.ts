import {
  workspace,
  window,
  env,
  commands,
  ExtensionContext,
  CancellationTokenSource,
  Uri,
  ProgressLocation,
  ThemeIcon,
  ViewColumn,
  Range,
  CodeAction,
  CodeActionKind,
} from "vscode";
import os from "os";
import path from "path";
import { StatusIssuesName } from "tabby-agent";
import { Client } from "../lsp/Client";
import { Config } from "../Config";
import { ContextVariables } from "../ContextVariables";
import { InlineCompletionProvider } from "../InlineCompletionProvider";
import { ChatSideViewProvider } from "../chat/ChatSideViewProvider";
import { ChatPanelViewProvider } from "../chat/ChatPanelViewProvider";
import { getFileContextFromSelection, getFileContext } from "../chat/fileContext";
import { GitProvider, Repository } from "../git/GitProvider";
import { showOutputPanel } from "../logger";
import { InlineEditController } from "../inline-edit";
import { CommandPalette } from "./commandPalette";
import { ConnectToServerWidget } from "./connectToServer";

export class Commands {
  private chatEditCancellationTokenSource: CancellationTokenSource | null = null;

  constructor(
    private readonly context: ExtensionContext,
    private readonly client: Client,
    private readonly config: Config,
    private readonly contextVariables: ContextVariables,
    private readonly inlineCompletionProvider: InlineCompletionProvider,
    private readonly chatViewProvider: ChatSideViewProvider,
    private readonly gitProvider: GitProvider,
  ) {}

  register() {
    const registrations = Object.entries(this.commands).map(([key, handler]) => {
      const commandName = `tabby.${key}`;
      return commands.registerCommand(commandName, handler, this);
    });
    this.context.subscriptions.push(...registrations);
  }

  private async sendMessageToChatPanel(msg: string) {
    const editor = window.activeTextEditor;
    if (editor) {
      commands.executeCommand("tabby.chatView.focus");
      const fileContext = await getFileContextFromSelection(editor, this.gitProvider);
      if (!fileContext) {
        window.showInformationMessage("No selected codes");
        return;
      }

      this.chatViewProvider.sendMessage({
        message: msg,
        selectContext: fileContext,
      });
    } else {
      window.showInformationMessage("No active editor");
    }
  }

  private addRelevantContext() {
    const editor = window.activeTextEditor;
    if (!editor) {
      window.showInformationMessage("No active editor");
      return;
    }

    const addContext = async () => {
      const fileContext = await getFileContextFromSelection(editor, this.gitProvider);
      if (fileContext) {
        this.chatViewProvider.addRelevantContext(fileContext);
      }
    };
    commands.executeCommand("tabby.chatView.focus");

    if (this.chatViewProvider.webview?.visible) {
      addContext();
    }
  }

  commands: Record<string, (...args: never[]) => void> = {
    applyCallback: (callback: (() => void) | undefined) => {
      callback?.();
    },
    toggleInlineCompletionTriggerMode: async (value: "automatic" | "manual" | undefined) => {
      let target = value;
      if (!target) {
        if (this.config.inlineCompletionTriggerMode === "automatic") {
          target = "manual";
        } else {
          target = "automatic";
        }
      }
      await this.config.updateInlineCompletionTriggerMode(target);
    },
    connectToServer: async (endpoint?: string | undefined) => {
      if (endpoint) {
        this.config.updateServerEndpoint(endpoint);
      } else {
        const widget = new ConnectToServerWidget(this.client, this.config);
        widget.show();
      }
    },
    openSettings: () => {
      commands.executeCommand("workbench.action.openSettings", "@ext:TabbyML.vscode-tabby");
    },
    openTabbyAgentSettings: () => {
      if (env.appHost !== "desktop") {
        window.showWarningMessage("Tabby Agent config file is not supported in browser.", { modal: true });
        return;
      }
      const agentUserConfig = Uri.joinPath(Uri.file(os.homedir()), ".tabby-client", "agent", "config.toml");
      workspace.fs.stat(agentUserConfig).then(
        () => {
          workspace.openTextDocument(agentUserConfig).then((document) => {
            window.showTextDocument(document);
          });
        },
        () => {
          window.showWarningMessage("Failed to open Tabby Agent config file.", { modal: true });
        },
      );
    },
    openOnlineHelp: (path?: string | undefined) => {
      if (typeof path === "string" && path.length > 0) {
        env.openExternal(Uri.parse(`https://tabby.tabbyml.com${path}`));
        return;
      }
      window
        .showQuickPick([
          {
            label: "Website",
            iconPath: new ThemeIcon("book"),
            alwaysShow: true,
            description: "Visit Tabby's website to learn more about features and use cases",
          },
          {
            label: "Tabby Slack Community",
            description: "Join Tabby's Slack community to get help or share feedback",
            iconPath: new ThemeIcon("comment-discussion"),
            alwaysShow: true,
          },
          {
            label: "Tabby GitHub Repository",
            description: "Open issues for bugs or feature requests",
            iconPath: new ThemeIcon("github"),
            alwaysShow: true,
          },
        ])
        .then((selection) => {
          if (selection) {
            switch (selection.label) {
              case "Website":
                env.openExternal(Uri.parse("https://www.tabbyml.com/"));
                break;
              case "Tabby Slack Community":
                env.openExternal(Uri.parse("https://links.tabbyml.com/join-slack-extensions/"));
                break;
              case "Tabby GitHub Repository":
                env.openExternal(Uri.parse("https://github.com/tabbyml/tabby"));
                break;
            }
          }
        });
    },
    openKeybindings: () => {
      commands.executeCommand("workbench.action.openGlobalKeybindings", "Tabby");
    },
    gettingStarted: () => {
      commands.executeCommand("workbench.action.openWalkthrough", "TabbyML.vscode-tabby#gettingStarted");
    },
    "commandPalette.trigger": () => {
      const commandPalette = new CommandPalette(this.client, this.config);
      commandPalette.show();
    },
    "outputPanel.focus": () => {
      showOutputPanel();
    },
    "inlineCompletion.trigger": () => {
      commands.executeCommand("editor.action.inlineSuggest.trigger");
    },
    "inlineCompletion.accept": async () => {
      const editor = window.activeTextEditor;
      if (!editor) {
        return;
      }

      const uri = editor.document.uri;
      const range = this.inlineCompletionProvider.calcEditedRangeAfterAccept();

      await commands.executeCommand("editor.action.inlineSuggest.commit");

      if (range) {
        applyQuickFixes(uri, range);
      }
    },
    "inlineCompletion.acceptNextWord": () => {
      this.inlineCompletionProvider.handleEvent("accept_word");
      commands.executeCommand("editor.action.inlineSuggest.acceptNextWord");
    },
    "inlineCompletion.acceptNextLine": () => {
      this.inlineCompletionProvider.handleEvent("accept_line");
      // FIXME: this command move cursor to next line, but we want to move cursor to the end of current line
      commands.executeCommand("editor.action.inlineSuggest.acceptNextLine");
    },
    "inlineCompletion.dismiss": () => {
      this.inlineCompletionProvider.handleEvent("dismiss");
      commands.executeCommand("editor.action.inlineSuggest.hide");
    },
    "status.addIgnoredIssues": (name: StatusIssuesName) => {
      this.client.status.editIgnoredIssues({ operation: "add", issues: name });
    },
    "status.resetIgnoredIssues": () => {
      this.client.status.editIgnoredIssues({ operation: "removeAll", issues: [] });
    },
    "chat.explainCodeBlock": async (userCommand?: string) => {
      this.sendMessageToChatPanel("Explain the selected code:".concat(userCommand ? `\n${userCommand}` : ""));
    },
    "chat.addRelevantContext": async () => {
      this.addRelevantContext();
    },
    "chat.addFileContext": async () => {
      const editor = window.activeTextEditor;
      if (editor) {
        const fileContext = await getFileContext(editor, this.gitProvider);
        if (fileContext) {
          commands.executeCommand("tabby.chatView.focus").then(async () => {
            this.chatViewProvider.addRelevantContext(fileContext);
          });
        }
      } else {
        window.showInformationMessage("No active editor");
      }
    },
    "chat.fixCodeBlock": async () => {
      this.sendMessageToChatPanel("Identify and fix potential bugs in the selected code:");
    },
    "chat.generateCodeBlockDoc": async () => {
      this.sendMessageToChatPanel("Generate documentation for the selected code:");
    },
    "chat.generateCodeBlockTest": async () => {
      this.sendMessageToChatPanel("Generate a unit test for the selected code:");
    },
    "chat.createPanel": async () => {
      const panel = window.createWebviewPanel("tabby.chatView", "Tabby", ViewColumn.One, {
        retainContextWhenHidden: true,
      });

      const chatPanelViewProvider = new ChatPanelViewProvider(this.context, this.client, this.gitProvider);

      chatPanelViewProvider.resolveWebviewView(panel);
    },
    "chat.edit.start": async (userCommand?: string, range?: Range) => {
      const editor = window.activeTextEditor;
      if (!editor) {
        return;
      }

      const editRange = range || editor.selection;

      const editLocation = {
        uri: editor.document.uri.toString(),
        range: {
          start: { line: editRange.start.line, character: 0 },
          end: {
            line: editRange.end.character === 0 ? editRange.end.line : editRange.end.line + 1,
            character: 0,
          },
        },
      };

      const inlineEditController = new InlineEditController(
        this.client,
        this.config,
        this.contextVariables,
        editor,
        editLocation,
        userCommand,
      );
      inlineEditController.start();
    },
    "chat.edit.stop": async () => {
      this.chatEditCancellationTokenSource?.cancel();
    },
    "chat.edit.accept": async () => {
      const editor = window.activeTextEditor;
      if (!editor) {
        return;
      }
      const location = {
        uri: editor.document.uri.toString(),
        range: {
          start: { line: editor.selection.start.line, character: 0 },
          end: { line: editor.selection.end.line + 1, character: 0 },
        },
      };
      await this.client.chat.resolveEdit({ location, action: "accept" });
    },
    "chat.edit.discard": async () => {
      const editor = window.activeTextEditor;
      if (!editor) {
        return;
      }
      const location = {
        uri: editor.document.uri.toString(),
        range: {
          start: { line: editor.selection.start.line, character: 0 },
          end: { line: editor.selection.end.line + 1, character: 0 },
        },
      };
      await this.client.chat.resolveEdit({ location, action: "discard" });
    },
    "chat.generateCommitMessage": async (repository?: Repository) => {
      let selectedRepo = repository;
      if (!selectedRepo) {
        const repos = this.gitProvider.getRepositories() ?? [];
        if (repos.length < 1) {
          window.showInformationMessage("No Git repositories found.");
          return;
        }
        if (repos.length == 1) {
          selectedRepo = repos[0];
        } else {
          const selected = await window.showQuickPick(
            repos
              .map((repo) => {
                const repoRoot = repo.rootUri.fsPath;
                return {
                  label: path.basename(repoRoot),
                  detail: repoRoot,
                  iconPath: new ThemeIcon("repo"),
                  picked: repo.ui.selected,
                  alwaysShow: true,
                  value: repo,
                };
              })
              .sort((a, b) => {
                if (a.detail.startsWith(b.detail)) {
                  return 1;
                } else if (b.detail.startsWith(a.detail)) {
                  return -1;
                } else {
                  return a.label.localeCompare(b.label);
                }
              }),
            { placeHolder: "Select a Git repository" },
          );
          selectedRepo = selected?.value;
        }
      }
      if (!selectedRepo) {
        return;
      }
      window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: "Generating commit message...",
          cancellable: true,
        },
        async (_, token) => {
          // Focus on scm view
          commands.executeCommand("workbench.view.scm");
          const result = await this.client.chat.generateCommitMessage(
            { repository: selectedRepo.rootUri.toString() },
            token,
          );
          if (result && selectedRepo.inputBox) {
            selectedRepo.inputBox.value = result.commitMessage;
          }
        },
      );
    },
  };
}

async function applyQuickFixes(uri: Uri, range: Range): Promise<void> {
  const codeActions = await commands.executeCommand<CodeAction[]>("vscode.executeCodeActionProvider", uri, range);
  const quickFixActions = codeActions.filter(
    (action) =>
      action.kind && action.kind.contains(CodeActionKind.QuickFix) && action.title.toLowerCase().includes("import"),
  );
  quickFixActions.forEach(async (action) => {
    try {
      if (action.edit) {
        await workspace.applyEdit(action.edit);
      }
      if (action.command) {
        await commands.executeCommand(action.command.command, action.command.arguments);
      }
    } catch (error) {
      // ignore errors
    }
  });
}