import clone from './clone';
import once from './once';

function toPromise(func) {
  // Create the function we will be returning
  return function (...args) {
    // Clone arguments
    const clonedArgs = clone(args);
    const self = this;
    
    // If the last argument is a function, assume it's a callback
    const lastArg = clonedArgs[clonedArgs.length - 1];
    const usedCB = typeof lastArg === 'function' ? clonedArgs.pop() : null;
    
    const promise = new Promise((resolve, reject) => {
      try {
        const callback = once((err, mesg) => {
          if (err) {
            reject(err);
          } else {
            resolve(mesg);
          }
        });
        
        // Create a callback for this invocation
        // Apply the function in the original context
        clonedArgs.push(callback);
        const resp = func.apply(self, clonedArgs);
        
        // If function returns a promise, use it
        if (resp && typeof resp.then === 'function') {
          resolve(resp);
        }
      } catch (e) {
        reject(e);
      }
    });
    
    // If there is a callback, call it back
    if (usedCB) {
      promise
        .then((result) => usedCB(null, result))
        .catch(usedCB);
    }
    
    return promise;
  };
}

export default toPromise;
