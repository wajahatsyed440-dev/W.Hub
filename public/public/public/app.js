let authMode = "signup";

let me = null;


/* =========================================================
   API
========================================================= */

async function api(
  url,
  options = {}
){

  const response =
    await fetch(
      url,
      {
        credentials:"same-origin",
        ...options,
        headers:{
          "Content-Type":
            "application/json",
          ...(options.headers || {})
        }
      }
    );


  const data =
    await response
      .json()
      .catch(()=>({}));


  if(!response.ok){

    throw new Error(
      data.error ||
      "Something went wrong."
    );
  }


  return data;
}


/* =========================================================
   LOAD ACCOUNT
========================================================= */

async function loadAccount(){

  try{

    const data =
      await api("/api/me");


    if(data.loggedIn){

      me = data;

    }else{

      me = null;

    }


    updateNav();

  }catch(error){

    console.error(error);

  }

}


/* =========================================================
   NAV
========================================================= */

function updateNav(){

  const button =
    document.getElementById(
      "authButton"
    );


  if(me){

    const name =
      me.user.email.split("@")[0];

    button.textContent =
      name;

    button.onclick =
      openDashboard;

  }else{

    button.textContent =
      "Sign up";

    button.onclick =
      openAuth;

  }
}


/* =========================================================
   STORE
========================================================= */

function showStore(){

  document
    .getElementById("store")
    .classList.remove("hidden");

  document
    .getElementById("dashboard")
    .classList.add("hidden");

  window.scrollTo({
    top:0,
    behavior:"smooth"
  });
}


function showPricing(){

  showStore();

  setTimeout(()=>{

    document
      .getElementById("pricing")
      .scrollIntoView({
        behavior:"smooth"
      });

  },50);

}


/* =========================================================
   AUTH
========================================================= */

function openAuth(mode="signup"){

  authMode = mode;

  document
    .getElementById("authModal")
    .classList.remove("hidden");

  document
    .getElementById("authTitle")
    .textContent =
      mode === "signup"
      ? "Create your account"
      : "Welcome back";

  document
    .getElementById("authText")
    .textContent =
      mode === "signup"
      ? "Your account stores your W.HUB purchases."
      : "Log in to access your software.";

  document
    .getElementById("switchButton")
    .textContent =
      mode === "signup"
      ? "Already have an account? Log in"
      : "Need an account? Sign up";

  document
    .getElementById("authError")
    .textContent = "";

}


function closeAuth(){

  document
    .getElementById("authModal")
    .classList.add("hidden");

}


function switchAuth(){

  openAuth(
    authMode === "signup"
    ? "login"
    : "signup"
  );

}


async function submitAuth(){

  const email =
    document
      .getElementById("email")
      .value
      .trim();

  const password =
    document
      .getElementById("password")
      .value;


  try{

    const endpoint =
      authMode === "signup"
      ? "/api/signup"
      : "/api/login";


    await api(
      endpoint,
      {
        method:"POST",

        body:JSON.stringify({
          email,
          password
        })
      }
    );


    closeAuth();

    await loadAccount();

    showToast(
      authMode === "signup"
      ? "Account created"
      : "Logged in"
    );


    if(
      window.pendingProduct
    ){

      const product =
        window.pendingProduct.product;

      const plan =
        window.pendingProduct.plan;

      window.pendingProduct =
        null;

      await startCheckout(
        product,
        plan
      );

    }

  }catch(error){

    document
      .getElementById("authError")
      .textContent =
        error.message;

  }

}


/* =========================================================
   CHECKOUT
========================================================= */

async function buy(
  product,
  plan
){

  if(!me){

    window.pendingProduct = {
      product,
      plan
    };

    openAuth("signup");

    return;
  }


  await startCheckout(
    product,
    plan
  );

}


async function startCheckout(
  product,
  plan
){

  try{

    showToast(
      "Opening checkout..."
    );


    const data =
      await api(
        "/api/checkout",
        {
          method:"POST",

          body:JSON.stringify({
            product,
            plan
          })
        }
      );


    /*
      Stripe gives us the REAL Checkout URL.
      No fake payment state is created here.
    */

    window.location.href =
      data.url;

  }catch(error){

    showToast(
      error.message
    );

  }

}


/* =========================================================
   DASHBOARD
========================================================= */

async function openDashboard(){

  if(!me){

    openAuth("login");

    return;
  }


  await loadAccount();


  document
    .getElementById("store")
    .classList.add("hidden");

  document
    .getElementById("dashboard")
    .classList.remove("hidden");


  renderDashboard();

}


function renderDashboard(){

  const container =
    document.getElementById(
      "dashboardContent"
    );


  const purchases =
    me.purchases || [];


  let html = `

    <div class="dashCard">

      <h2>Your software</h2>

      <p>
        ${escapeHTML(me.user.email)}
      </p>

  `;


  if(purchases.length === 0){

    html += `

      <p>
        You haven't purchased any software yet.
      </p>

    `;

  }else{

    purchases.forEach(p=>{

      const download =
        p.product === "W.Edits"
        ? "/download/w-edits"
        : "/download/w-photo";


      html += `

        <div class="purchase">

          <div>

            <strong>
              ${escapeHTML(p.product)}
            </strong>

            <small>
              ${
                p.plan === "monthly"
                ? "Monthly subscription"
                : "One-time purchase"
              }

              •

              ${
                p.status
              }

            </small>

          </div>

          <a
            class="primary"
            style="
              padding:10px 14px;
              border-radius:12px;
              color:white;
              text-decoration:none"
            href="${download}">

            Download

          </a>

        </div>

      `;

    });

  }


  html += `

    </div>

    <div class="dashCard">

      <h2>Account</h2>

      <p>
        Account created:
        ${new Date(
          me.user.created_at
        ).toLocaleDateString()}
      </p>

      <button onclick="logout()">
        Log out
      </button>

    </div>

  `;


  container.innerHTML =
    html;

}


/* =========================================================
   LOGOUT
========================================================= */

async function logout(){

  try{

    await api(
      "/api/logout",
      {
        method:"POST"
      }
    );

    me = null;

    updateNav();

    showStore();

    showToast(
      "Logged out"
    );

  }catch(error){

    showToast(
      error.message
    );

  }

}


/* =========================================================
   TOAST
========================================================= */

function showToast(
  message
){

  const toast =
    document.getElementById(
      "toast"
    );

  toast.textContent =
    message;

  toast.classList.remove(
    "hidden"
  );


  clearTimeout(
    window.toastTimeout
  );


  window.toastTimeout =
    setTimeout(()=>{

      toast.classList.add(
        "hidden"
      );

    },4000);

}


/* =========================================================
   UTILITY
========================================================= */

function escapeHTML(
  value
){

  return String(value)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );

}


/* =========================================================
   PAYMENT RETURN
========================================================= */

function checkPaymentReturn(){

  const params =
    new URLSearchParams(
      window.location.search
    );


  if(
    params.get("payment")
    === "success"
  ){

    showToast(
      "Payment submitted. Your purchase will appear once Stripe's webhook confirms it."
    );

    setTimeout(
      openDashboard,
      1000
    );

  }


  if(
    params.get("payment")
    === "cancelled"
  ){

    showToast(
      "Payment cancelled."
    );

  }

}


/* =========================================================
   START
========================================================= */

(async function(){

  await loadAccount();

  checkPaymentReturn();

})();
