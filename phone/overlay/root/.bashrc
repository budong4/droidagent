# ~/.bashrc - phone agent chroot
[ -z "${PS1:-}" ] && return

HISTSIZE=10000
HISTFILESIZE=20000
shopt -s histappend checkwinsize
[ -f /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion

# Hostname is shared with Android (no UTS namespace), so name the chroot in the prompt instead.
PS1='\[\e[1;32m\]\u@k70u-debian\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '

alias ls='ls --color=auto'
alias ll='ls -alF'
alias grep='grep --color=auto'
