import { of, zip, Observable, concat, empty } from 'rxjs';
import { switchMap, catchError, takeUntil, map, merge } from 'rxjs/operators';
import { ActionsObservable } from 'redux-observable';
import marked from 'marked';
import {
  getPullRequest,
  getPullRequestAsDiff,
  getPullRequestComments,
  getPullRequestFromGraphQL,
  getPullRequestReviewComments,
  PullRequestReviewState,
  pullRequestReviewFragment,
  pullRequestReviewCommentRestLikeFragment,
  PullRequestReviewDTO,
  PullRequestDTO,
  GraphQLError,
} from '../lib/Github';
import { isAuthenticated, getUserInfo } from '../lib/GithubAuth';
import { observeReviewStates } from '../lib/Database';
import { parseDiff, DiffFile } from '../lib/DiffParser';
import getInitialState, { AppState } from './getInitialState';
import { COMMENTS_FETCHED, PENDING_COMMENTS_FETCHED } from './CommentStore';

const FETCH = 'FETCH';
const FETCH_CANCEL = 'FETCH_CANCEL';
const FETCH_ERROR = 'FETCH_ERROR';
const FETCH_SUCCESS = 'FETCH_SUCCESS';

const REVIEW_STATES_CHANGED = 'REVIEW_STATES_CHANGED';

type FetchAction = {
  type: 'FETCH';
  payload: {
    owner: string;
    repo: string;
    number: number;
  };
};

export type PullRequestAction =
  FetchAction |
  { type: 'FETCH_CANCEL'; } |
  { type: 'FETCH_ERROR'; payload: { status: 404 }; } |
  { type: 'FETCH_SUCCESS'; payload: {
    pullRequest: PullRequestDTO;
    pullRequestBodyRendered: string;
    files: DiffFile[];
    latestReview: PullRequestReviewDTO | null;
    isLoadingReviewStates: boolean;
  }; } |
  { type: 'REVIEW_STATES_CHANGED'; payload: {[fileId: string]: boolean}; }
  ;

export function fetch({ owner, repo, number }: FetchAction['payload']): PullRequestAction {
  return { type: 'FETCH', payload: { owner, repo, number } };
}

export function fetchCancel(): PullRequestAction {
  return { type: 'FETCH_CANCEL' };
}

export const pullRequestEpic = (action$: ActionsObservable<PullRequestAction>) =>
  action$.ofType<FetchAction>(FETCH).pipe(switchMap(action =>
    zip<Observable<PullRequestDTO>, Observable<string>, Observable<any>>(
      getPullRequest(action.payload.owner, action.payload.repo, action.payload.number),
      getPullRequestAsDiff(action.payload.owner, action.payload.repo, action.payload.number),
      getUserInfo() ?
        getPullRequestFromGraphQL(action.payload.owner, action.payload.repo, action.payload.number,
          getUserInfo()!.login, `
          bodyHTML
          reviews(last: 1, author: $author) {
            nodes {
              ${pullRequestReviewFragment}
            }
          }
          pendingReviews: reviews(last: 1, author: $author, states: [PENDING]) {
            nodes {
              ${pullRequestReviewFragment}
              comments(last: 100) {
                nodes {
                  ${pullRequestReviewCommentRestLikeFragment}
                }
                pageInfo {
                  hasPreviousPage
                  startCursor
                }
              }
            }
          }
        `).pipe(catchError((error: GraphQLError[]) => {
          if (error.some(e => e.type === 'NOT_FOUND')) {
            throw { status: 404 }; // XXX
          }
          throw error;
        })) :
        of(null)
    ).pipe(
    switchMap(([ pullRequest, diff, pullRequestFromGraphQL ]) => {
      const authenticated = isAuthenticated();
      let latestReview: PullRequestReviewDTO | null = null;
      let pullRequestBodyRendered;
      if (pullRequestFromGraphQL) {
        // FIXME: Pending review is always on the first of reviews connection
        latestReview = pullRequestFromGraphQL.pendingReviews.nodes[0] || pullRequestFromGraphQL.reviews.nodes[0];
        pullRequestBodyRendered = pullRequestFromGraphQL.bodyHTML;
      } else {
        pullRequestBodyRendered = marked(pullRequest.body, { gfm: true, sanitize: true });
      }
      const success$ = of(({
        type: FETCH_SUCCESS,
        payload: {
          pullRequest,
          pullRequestBodyRendered,
          files: parseDiff(diff),
          latestReview,
          isLoadingReviewStates: authenticated,
        },
      }));

      let comments$ = getPullRequestComments(pullRequest)
        .pipe(map(comments => ({ type: COMMENTS_FETCHED, payload: comments })));
      if (latestReview && latestReview.state === PullRequestReviewState.PENDING) {
        const pendingComments$ = latestReview.comments!.pageInfo.hasPreviousPage ?
          getPullRequestReviewComments(pullRequest, latestReview.id, latestReview.comments!.pageInfo.startCursor)
            .pipe(map(morePendingComments => morePendingComments.concat(latestReview!.comments!.nodes))) :
          of(latestReview.comments!.nodes);
        comments$ = comments$.pipe(merge(
          pendingComments$.pipe(map(pendingComments => ({
            type: PENDING_COMMENTS_FETCHED,
            payload: pendingComments,
          })))
        ));
      }

      const reviewStates$ = authenticated ?
        observeReviewStates(pullRequest.id)
          .pipe(map(reviewStates =>
            ({ type: REVIEW_STATES_CHANGED, payload: reviewStates || {} }))) :
        empty();
      
      return concat(success$, comments$.pipe(merge(reviewStates$)));
    }),
    catchError(error => {
      console.error(error);
      return of({ type: FETCH_ERROR, payload: error });
    }),
    takeUntil(action$.ofType(FETCH_CANCEL))
  )));

export default function pullRequestReducer(state: AppState, action: PullRequestAction): AppState {
  switch (action.type) {
    case FETCH:
      return getInitialState();

    case FETCH_ERROR:
      return {
        ...state,
        status: action.payload && action.payload.status === 404 ? 'notFound' : 'loading',
      };

    case FETCH_SUCCESS:
      return {
        ...state,
        status: 'success',
        ...action.payload,
      };

    case REVIEW_STATES_CHANGED:
      return {
        ...state,
        reviewStates: action.payload,
        isLoadingReviewStates: false,
      };
    
    default:
      return state;
  }
}
