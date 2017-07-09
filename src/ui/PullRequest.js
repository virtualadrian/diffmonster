import React, { Component } from 'react';
import { findDOMNode } from 'react-dom';
import { connect } from 'react-redux';
import DocumentTitle from 'react-document-title';
import g from 'glamorous';
import { Colors, Classes, Switch, NonIdealState } from '@blueprintjs/core';
import FileTree from './FileTree';
import Diff from './Diff';
import Header from './Header';
import Summary from './Summary';
import Loading from './Loading';
import { startAuth, isAuthenticated } from '../lib/GithubAuth';
import { setReviewState } from '../lib/Database';
import * as Settings from '../lib/Settings';
import { deleteComment } from '../stores/CommentStore';

const NoPreview = g.div({
  padding: '16px',
});

const Panel = g.div({
  background: Colors.WHITE,
  borderRadius: '3px',
  boxShadow: '0 0 1px rgba(0, 0, 0, 0.2)',
});

const PanelHeader = g.div({
  display: 'flex',
  flex: '0 0 auto',
  padding: '0 16px',
  lineHeight: '32px',
  height: '32px',

  color: Colors.DARK_GRAY1,
  background: Colors.LIGHT_GRAY5,
  borderBottom: `1px solid ${Colors.GRAY5}`,
});

const FileTreePanel = g(Panel)({
  flex: '0 0 auto',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  margin: '0 0 6px 6px',
});

const ResizeHandle = g.div({
  cursor: 'ew-resize',
  width: '6px',
});

const ContentPanel = g(Panel)({
  flex: '1',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  margin: '0 6px 6px 0',
});

function collectCommentCountByPath(comments, commentCountByPath) {
  for (let comment of comments) {
    if (!comment.position)
      continue;
    if (!commentCountByPath[comment.path])
      commentCountByPath[comment.path] = 0;
    commentCountByPath[comment.path]++;
  }
}

class PullRequest extends Component {
  _fileTreeWidth = Settings.getFileTreeWidth();

  componentDidUpdate(prevProps) {
    if (prevProps.activePath !== this.props.activePath) {
      if (this._scrollEl)
        findDOMNode(this._scrollEl).scrollTop = 0;
    }
  }

  render() {
    if (this.props.status === 'loading')
      return <Loading />;
    
    if (this.props.status === 'notFound')
      return this._renderNotFound();

    const pullRequest = this.props.pullRequest;

    return (
      <DocumentTitle title={`${pullRequest.title} - ${pullRequest.base.repo.full_name}#${pullRequest.number}`}>
        <g.Div flex="1" overflow="auto" display="flex" flexDirection="column" background={Colors.DARK_GRAY3}>
          <g.Div flex="0" className={Classes.DARK}>
            <Header />
          </g.Div>
          <g.Div flex="1" display="flex" overflow="auto">
            {this._renderFileTree()}
            <ResizeHandle onMouseDown={this._beginResize} />
            {this._renderContent()}
          </g.Div>
        </g.Div>
      </DocumentTitle>
    );
  }

  _renderFileTree() {
    const {
      files,
      comments,
      pendingComments,
      isLoadingReviewStates,
      reviewStates,
      activePath,
      onSelectFile,
    } = this.props;
    
    const commentCountByPath = {};
    collectCommentCountByPath(comments, commentCountByPath);
    collectCommentCountByPath(pendingComments, commentCountByPath);

    return (
      <FileTreePanel innerRef={el => this._fileTreeEl = el} style={{width: this._fileTreeWidth + 'px'}}>
        <PanelHeader>
          <g.Div flex="1">
            Files
          </g.Div>
          <g.Div flex="initial">
            {reviewStates ?
              <g.Span color={Colors.GRAY1}>{this._getReviewedFileCount()} of {files.length} reviewed</g.Span> :
              isLoadingReviewStates &&
                <g.Span color={Colors.GRAY4}>Loading...</g.Span>}
          </g.Div>
        </PanelHeader>
        <FileTree
          files={files.map(file => ({
            ...file,
            commentCount: commentCountByPath[file.filename],
            isReviewed: reviewStates && reviewStates[file.sha],
          }))}
          activePath={activePath}
          onSelectFile={onSelectFile}
        />
      </FileTreePanel>
    );
  }

  _renderContent() {
    const {
      pullRequest,
      files,
      comments,
      pendingComments,
      activePath,
      reviewStates,
    } = this.props;
    const activeFile = activePath && files.filter(file => file.filename === activePath)[0];

    return (
      <ContentPanel>
        {activeFile &&
          <PanelHeader>
            <g.Div flex="1">
              {activeFile.filename}
              {activeFile.previous_filename &&
                <g.Span color={Colors.GRAY1}> (was: {activeFile.previous_filename})</g.Span>}
            </g.Div>
            <g.Div flex="initial">
              {reviewStates && <Switch
                className="pt-inline"
                checked={reviewStates[activeFile.sha] || false}
                label="Done"
                onChange={this._onReviewStateChange}
              />}
              <a href={getBlobUrl(pullRequest, activeFile)} target="_blank" rel="noopener noreferrer">View</a>
            </g.Div>
          </PanelHeader>}
        <g.Div flex="1" overflowY="auto" ref={el => this._scrollEl = el}>
          {activeFile ?
            activeFile.blocks && activeFile.blocks.length > 0 ?
              <Diff
                file={activeFile}
                comments={comments.filter(c => c.path === activePath)}
                pendingComments={pendingComments.filter(c => c.path === activePath)}
                canCreateComment={isAuthenticated()}
                deleteComment={this._deleteComment}
              /> :
              <NoPreview>
                No change
              </NoPreview> :
            <Summary pullRequest={pullRequest} />
          }
        </g.Div>
      </ContentPanel>
    );
  }

  _renderNotFound() {
    return (
      <NonIdealState
        title="Not Found"
        visual="warning-sign"
        description={
          <p>
            <a href="" onClick={this._login}>Login with GitHub</a> to view private repos.
          </p>
        }
      />
    )
  }

  _getReviewedFileCount() {
    let count = 0;
    if (this.props.reviewStates) {
      this.props.files.forEach(file => {
        if (this.props.reviewStates[file.sha])
          count++;
      });
    }
    return count;
  }

  _onReviewStateChange = event => {
    const {
      pullRequest,
      files,
      activePath,
    } = this.props;
    const activeFile = activePath && files.filter(file => file.filename === activePath)[0];
    setReviewState(pullRequest.id, activeFile.sha, event.target.checked);
  };

  _login = event => {
    event.preventDefault();
    startAuth();
  };

  _deleteComment = commentId => {
    if (window.confirm('Are you sure?')) {
      this.props.dispatch(deleteComment(commentId));
    }
  };

  // Resizing - directly manipulates DOM to bypass React rendering

  _beginResize = event => {
    event.preventDefault(); // prevent text selection

    document.addEventListener('mouseup', this._endResize, false);
    document.addEventListener('mousemove', this._resize, false);
  };

  _resize = event => {
    event.preventDefault(); // prevent text selection

    // FIXME: 6px is left margin but hardcoded
    const minWidth = 200;
    const maxWidth = 800;
    this._fileTreeWidth = Math.min(Math.max(minWidth, event.clientX - 6), maxWidth);
    this._fileTreeEl.style.width = this._fileTreeWidth + 'px';
  };

  _endResize = event => {
    event.preventDefault(); // prevent text selection

    document.removeEventListener('mouseup', this._beginResize);
    document.removeEventListener('mousemove', this._resize);

    Settings.setFileTreeWidth(this._fileTreeWidth);
  };
}

function getBlobUrl(pullRequest, file) {
  return `${pullRequest.head.repo.html_url}/blob/${pullRequest.head.sha}/${file.filename}`;
}

export default connect(state => state)(PullRequest);