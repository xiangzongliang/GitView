package main

// RepoEntry is a repository registered in the app configuration.
type RepoEntry struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Group      string `json:"group"` // user-defined group; "" = ungrouped
	LastOpened int64  `json:"lastOpened"`
	Missing    bool   `json:"missing"` // path no longer exists on disk
}

// FileStatus describes one changed file in the index or worktree.
type FileStatus struct {
	Path       string `json:"path"`
	OldPath    string `json:"oldPath,omitempty"` // rename/copy source
	StatusChar string `json:"statusChar"`        // porcelain code: M A D R C ? U
	Renamed    bool   `json:"renamed"`
	Conflicted bool   `json:"conflicted"`
}

// RepoStatus is a snapshot of the working tree / index state.
type RepoStatus struct {
	Branch        string       `json:"branch"`
	Detached      bool         `json:"detached"`
	Head          string       `json:"head"` // "" when unborn (no commits yet)
	Upstream      string       `json:"upstream"`
	Ahead         int          `json:"ahead"`
	Behind        int          `json:"behind"`
	Staged        []FileStatus `json:"staged"`
	Unstaged      []FileStatus `json:"unstaged"`
	Untracked     []FileStatus `json:"untracked"`
	Conflicted    []FileStatus `json:"conflicted"`
	StashCount    int          `json:"stashCount"`
	Merging       bool         `json:"merging"`
	Rebasing      bool         `json:"rebasing"`
	CherryPicking bool         `json:"cherryPicking"`
	Reverting     bool         `json:"reverting"`
}

// RefDecoration is a parsed branch/tag/remote decoration attached to a commit.
type RefDecoration struct {
	Name    string `json:"name"`
	Type    string `json:"type"` // "branch" | "remote" | "tag"
	Current bool   `json:"current"`
}

// Commit is one line of git log output.
type Commit struct {
	Hash        string          `json:"hash"`
	Parents     []string        `json:"parents"`
	Author      string          `json:"author"`
	AuthorEmail string          `json:"authorEmail"`
	Timestamp   int64           `json:"timestamp"` // unix seconds
	Subject     string          `json:"subject"`
	Body        string          `json:"body"`
	Refs        []RefDecoration `json:"refs"`
}

// LogOptions controls a paginated git log query.
type LogOptions struct {
	Ref    string `json:"ref"` // "all", "" (= HEAD) or any revision
	Skip   int    `json:"skip"`
	Limit  int    `json:"limit"`
	Search string `json:"search"` // case-insensitive --grep
	File   string `json:"file"`   // restrict to a path
}

// BranchInfo describes a local or remote-tracking branch.
type BranchInfo struct {
	Name      string `json:"name"` // local: "main", remote: "origin/main"
	IsCurrent bool   `json:"isCurrent"`
	IsRemote  bool   `json:"isRemote"`
	Remote    string `json:"remote"`   // remote name for remote branches
	Tracking  string `json:"tracking"` // upstream of a local branch
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	Gone      bool   `json:"gone"` // upstream no longer exists
	LastHash  string `json:"lastHash"`
	Timestamp int64  `json:"timestamp"`
	Subject   string `json:"subject"`
}

// TagInfo describes a tag.
type TagInfo struct {
	Name      string `json:"name"`
	Hash      string `json:"hash"`
	Timestamp int64  `json:"timestamp"`
	Subject   string `json:"subject"`
}

// RemoteInfo describes a remote and its tracking branches.
type RemoteInfo struct {
	Name     string       `json:"name"`
	URL      string       `json:"url"`
	Branches []BranchInfo `json:"branches"`
}

// RefsData bundles everything the sidebar navigation needs.
type RefsData struct {
	Branches []BranchInfo `json:"branches"`
	Remotes  []RemoteInfo `json:"remotes"`
	Tags     []TagInfo    `json:"tags"`
}

// StashEntry is one stash reflog record.
type StashEntry struct {
	Index     int    `json:"index"`
	Ref       string `json:"ref"` // stash@{0}
	Branch    string `json:"branch"`
	Message   string `json:"message"`
	Timestamp int64  `json:"timestamp"`
}

// CommitFile is one file changed in a commit.
type CommitFile struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Status    string `json:"status"` // A M D R C
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary"`
}

// CommitOptions configures a commit.
type CommitOptions struct {
	Message string `json:"message"`
	Amend   bool   `json:"amend"`
}

// BranchOptions configures branch creation.
type BranchOptions struct {
	Name     string `json:"name"`
	Start    string `json:"start"` // revision to start from, "" = HEAD
	Checkout bool   `json:"checkout"`
}

// MergeOptions configures a merge.
type MergeOptions struct {
	Ref   string `json:"ref"`
	NoFF  bool   `json:"noFF"`
	Squash bool  `json:"squash"`
}

// PushOptions configures a push.
type PushOptions struct {
	Remote      string `json:"remote"`
	Branch      string `json:"branch"` // "" = current branch
	Force       bool   `json:"force"`
	SetUpstream bool   `json:"setUpstream"`
	PushTags    bool   `json:"pushTags"`
}

// PullOptions configures a pull.
type PullOptions struct {
	Remote    string `json:"remote"`
	Branch    string `json:"branch"`
	Rebase    bool   `json:"rebase"`
	Autostash bool   `json:"autostash"`
}

// StashOptions configures stash creation.
type StashOptions struct {
	Message          string `json:"message"`
	IncludeUntracked bool   `json:"includeUntracked"`
	KeepIndex        bool   `json:"keepIndex"`
}

// TagOptions configures tag creation.
type TagOptions struct {
	Name    string `json:"name"`
	Target  string `json:"target"` // "" = HEAD
	Message string `json:"message"`
	Push    bool   `json:"push"`
	Remote  string `json:"remote"`
}

// CloneOptions configures a clone.
type CloneOptions struct {
	URL      string `json:"url"`
	Parent   string `json:"parent"` // destination directory
	Name     string `json:"name"`   // "" = derived from URL
	Branch   string `json:"branch"` // "" = default
	Username string `json:"username"`
	Password string `json:"password"` // password or personal access token
}

// OpResult carries human-readable output of a git operation.
type OpResult struct {
	Output  string `json:"output"`
	Success bool   `json:"success"`
}

// CommandResult carries the outcome of a built-in terminal command.
type CommandResult struct {
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode"`
	// NewCwd is the working directory after the command ran (so `cd` persists).
	NewCwd  string `json:"newCwd"`
	Timeout bool   `json:"timeout"`
}
