---
name: lsdd-docs-commit
description: spec・notes・tasks・plans の文書だけをコミットする。人が文書を承認した時点（実装に入る前）に人が呼ぶ。コードに変更があればコミットせずに止める。
argument-hint: <どこまで進んだかの1行（コミットメッセージの1行目）> [本文に足す1行]
---

# 文書だけのコミットを作る

引数: $ARGUMENTS

## 手順

1. `git status --porcelain` を実行し、出力をそのまま報告に貼る。
2. 変更が `CLAUDE.md`・`spec/`・`notes/`・`tasks/`・`plans/` の下だけでなければ、コミットせずに止めて、どのファイルが範囲の外かを報告する。
3. 範囲の中の変更だけを `git add` して、コミットする。メッセージの1行目は引数の1行目、本文があれば引数の残りを書く。既存のコミットは書き換えない（amend しない）。
4. `git status` と `git show --stat HEAD` の出力をそのまま報告する。

## 報告に書くこと

- コミット前の `git status --porcelain`
- コミットのハッシュ
- コミット後の `git status` と `git show --stat HEAD`
