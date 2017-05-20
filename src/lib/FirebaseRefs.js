import * as firebase from 'firebase';
import { Observable } from 'rxjs/Observable';

export function refValues(ref) {
  return Observable.create(obs => {
    const callback = ref.on('value', snapshot => obs.next(snapshot.val()), err => obs.error(err));
    return () => ref.off('value', callback);
  });
}

export function githubTokenRef(uid) {
  return firebase.database().ref(`githubTokens/${uid}`);
}